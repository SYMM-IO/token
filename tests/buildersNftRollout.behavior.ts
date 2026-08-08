import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect } from "chai"
import hre, { artifacts, ethers, upgrades } from "hardhat"

import { loadRolloutConfig, requireManagerDeploymentConfig } from "../scripts/builders-nft/lib/config"
import { buildLedgerCandidates, scanLedgerApp } from "../scripts/builders-nft/lib/ledger"
import { scanAccessControlMembers } from "../scripts/builders-nft/lib/onchain"
import { bindRolloutState, loadRolloutState, saveRolloutState } from "../scripts/builders-nft/lib/state"
import { findCompiledStorageLayout, loadStorageBaseline, validateNftUpgrade } from "../scripts/builders-nft/lib/upgradeValidation"
import { deploySymmioBuildersNftManager } from "../tasks/symmioBuildersNftManager"

describe("Builders NFT rollout tooling", () => {
	const configFile = path.resolve("scripts/builders-nft/config/builders-nft.base.json")
	const baselineFile = path.resolve("scripts/builders-nft/config/symmio-builders-nft-v1.baseline.json")

	it("builds deterministic, de-duplicated Ledger candidates and persists the matched ID", async () => {
		const scan = {
			accountCount: 2,
			addressCount: 2,
			extraPaths: ["m/44'/60'/0'/0/0", "m/44'/60'/9'/0/0"],
		}
		const candidates = buildLedgerCandidates(scan)
		expect(candidates.map(candidate => candidate.id)).to.deep.equal(candidates.map((_, index) => index))
		expect(new Set(candidates.map(candidate => candidate.path)).size).to.equal(candidates.length)

		const expected = ethers.Wallet.createRandom().address
		const other = ethers.Wallet.createRandom().address
		const matchedCandidate = candidates[3]
		const discovery = await scanLedgerApp(
			{
				getAddress: async ledgerPath => ({ address: ledgerPath === matchedCandidate.path ? expected : other }),
				signTransaction: async () => {
					throw new Error("not called")
				},
			},
			expected,
			scan,
		)
		expect(discovery.candidateId).to.equal(matchedCandidate.id)
		expect(discovery.path).to.equal(matchedCandidate.path)
	})

	it("binds persisted state to one chain and config", () => {
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "builders-nft-rollout-"))
		const stateFile = path.join(temporaryDirectory, "state.json")
		const expected = { chainId: 8453, networkName: "base", configFile }
		const state = bindRolloutState({}, expected)
		saveRolloutState(stateFile, state)
		expect(loadRolloutState(stateFile).metadata).to.deep.equal(expected)
		expect(() => bindRolloutState(loadRolloutState(stateFile), { ...expected, chainId: 1 })).to.throw("does not match")
	})

	it("reconstructs current role membership from grant and revoke logs", async () => {
		const [admin, activeMember, revokedMember] = await ethers.getSigners()
		const factory = await ethers.getContractFactory("Symmio")
		const token = await factory.deploy("SYMM", "SYMM", admin.address)
		await token.waitForDeployment()
		const role = await token.MINTER_ROLE()
		await (await token.grantRole(role, activeMember.address)).wait()
		await (await token.grantRole(role, revokedMember.address)).wait()
		await (await token.revokeRole(role, revokedMember.address)).wait()

		const result = await scanAccessControlMembers(ethers.provider, await token.getAddress(), role, 1)
		expect(result.deploymentBlock).to.be.greaterThan(0)
		expect(result.members).to.deep.equal([activeMember.address])
	})

	it("requires every economic and authority value before manager deployment", () => {
		const { config } = loadRolloutConfig(configFile)
		expect(config.upgrade.acceptedRemovedFunctions).to.deep.equal(["lockData(uint256)"])
		expect(() => requireManagerDeploymentConfig(config)).to.throw("manager.penaltyRate")
	})

	it("reuses the manager task with a signer and explicit ProxyAdmin owner", async () => {
		const [deployer, managerAdmin, proxyAdminOwner, penaltyReceiver] = await ethers.getSigners()
		const symmFactory = await ethers.getContractFactory("Symmio", deployer)
		const symm = await symmFactory.deploy("SYMM", "SYMM", managerAdmin.address)
		await symm.waitForDeployment()
		const nftFactory = await ethers.getContractFactory("SymmioBuildersNft", deployer)
		const nft = await upgrades.deployProxy(nftFactory, [managerAdmin.address], { initializer: "initialize" })
		await nft.waitForDeployment()

		const deployment = await deploySymmioBuildersNftManager(
			{
				symm: await symm.getAddress(),
				nft: await nft.getAddress(),
				admin: managerAdmin.address,
				minlockamount: ethers.parseEther("100").toString(),
				cliffduration: "10",
				vestingduration: "3600",
				penaltyrate: ethers.parseUnits("0.2", 18).toString(),
				penaltyreceiver: penaltyReceiver.address,
				proxyadminowner: proxyAdminOwner.address,
				grantroles: false,
			},
			hre,
			deployer,
		)
		const proxyAdmin = new ethers.Contract(deployment.proxyAdminAddress, ["function owner() view returns (address)"], ethers.provider)
		expect(await proxyAdmin.owner()).to.equal(proxyAdminOwner.address)
		expect(await deployment.contract.hasRole(ethers.ZeroHash, managerAdmin.address)).to.equal(true)
	})

	it("proves storage compatibility but blocks the unaccepted lockData ABI removal", async () => {
		const baseline = loadStorageBaseline(baselineFile)
		const artifact = await artifacts.readArtifact("SymmioBuildersNft")
		const updatedLayout = findCompiledStorageLayout(baseline.contract)
		const blocked = validateNftUpgrade({
			baseline,
			updatedLayout,
			updatedAbi: artifact.abi,
			acceptedRemovedFunctions: [],
		})
		expect(blocked.storageCompatible).to.equal(true)
		expect(blocked.removedFunctions).to.deep.equal(["lockData(uint256)"])
		expect(blocked.unacceptedRemovedFunctions).to.deep.equal(["lockData(uint256)"])
		expect(blocked.ok).to.equal(false)

		const accepted = validateNftUpgrade({
			baseline,
			updatedLayout,
			updatedAbi: artifact.abi,
			acceptedRemovedFunctions: ["lockData(uint256)"],
		})
		expect(accepted.storageCompatible).to.equal(true)
		expect(accepted.unacceptedRemovedFunctions).to.deep.equal([])
		expect(accepted.ok).to.equal(true)
	})
})
