import { expect } from "chai"
import { ethers, run, network } from "hardhat"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { pledgeTransactions, readPledgeConfiguration } from "../tasks/builderNftPledge"
import { initializeFixture } from "./Initialize.fixture"

describe("NFTManager pledge preparation", () => {
	before(() => {
		if (network.name !== "hardhat") throw new Error("Local tests only")
	})
	it("prepares unsigned artifacts and separate Safe actions without broadcasting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nft-pledge-prepare-"))
		try {
			const [signer] = await ethers.getSigners()
			const before = await signer.getNonce()
			const output = join(directory, "preparation.json")
			const manifest = await run("pledge:prepare", { output })
			expect(await signer.getNonce()).to.equal(before)
			expect(manifest.status).to.equal("prepared-not-deployed-or-upgraded")
			expect(manifest.upgradeTemplate.readyToExecute).to.equal(false)
			const manager = await ethers.getContractFactory("SymmioBuildersNftManager")
			expect(manager.interface.decodeFunctionData("initializePledges", manifest.initializationCalldata)[0]).to.equal(
				manifest.configuration.controller,
			)
			const input = JSON.parse(readFileSync(`${output}.solc-input.json`, "utf8"))
			expect(input.sources["contracts/builders-nft/SymmioBuildersNftManager.sol"]).to.have.property("content")
			expect(manifest.transactions).not.to.have.property("configure")
			expect(manager.interface.decodeFunctionData("initializePledges", manifest.initializationCalldata)[1]).to.equal(
				BigInt(manifest.configuration.minimumPledgeCollateral),
			)
			for (const action of ["release", "seize"] as const) {
				const batch = JSON.parse(readFileSync(`${output}.${action}.safe.json`, "utf8"))
				expect(batch.chainId).to.equal("8453")
				expect(batch.transactions).to.have.length(1)
				expect(batch.transactions[0].data).to.equal(manifest.transactions[action].data)
			}
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	async function fixture() {
		const context = await initializeFixture()
		const {
			symmioBuildersNftManager: manager,
			symmioBuildersNft: nft,
			signers: { admin, user1: carbon, user2: safe },
		} = context
		await manager.connect(admin).initializePledges(safe.address, ethers.parseEther("8800000"))
		await manager.mintWithoutBurn(carbon.address, ethers.parseEther("8800000"), "IntentX")
		const config = {
			...readPledgeConfiguration("configs/carbon-builder-nft-pledge.json"),
			manager: await manager.getAddress(),
			nft: await nft.getAddress(),
			beneficiary: carbon.address,
			controller: safe.address,
			tokenId: "0",
		}
		return { manager, nft, carbon, safe, transactions: pledgeTransactions(config, manager.interface) }
	}
	for (const action of ["release", "seize"] as const) {
		it(`executes the generated approval, pledge and ${action} calldata locally`, async () => {
			const { manager, nft, carbon, safe, transactions } = await loadFixture(fixture)
			const send = (signer: typeof carbon, transaction: typeof transactions.approve) =>
				signer.sendTransaction({ to: transaction.to, data: transaction.data, value: transaction.value })
			await send(carbon, transactions.approve)
			await send(carbon, transactions.pledge)
			expect(await nft.ownerOf(0)).to.equal(await manager.getAddress())
			await send(safe, transactions[action])
			expect(await nft.ownerOf(0)).to.equal(action === "release" ? carbon.address : safe.address)
		})
	}
})
