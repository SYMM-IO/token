import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect } from "chai"
import hre, { artifacts, ethers, upgrades } from "hardhat"

import { loadRolloutConfig, requireManagerDeploymentConfig } from "../scripts/builders-nft/lib/config"
import { scanAccessControlMembers } from "../scripts/builders-nft/lib/onchain"
import { resolveConfiguredSigner } from "../scripts/builders-nft/lib/signer"
import { bindRolloutState, loadRolloutState, saveRolloutState } from "../scripts/builders-nft/lib/state"
import { findCompiledStorageLayout, loadStorageBaseline, validateNftUpgrade } from "../scripts/builders-nft/lib/upgradeValidation"
import { deploySymmioBuildersNftManager } from "../tasks/symmioBuildersNftManager"

describe("Builders NFT rollout tooling", () => {
	const configFile = path.resolve("scripts/builders-nft/config/builders-nft.base.json")
	const baselineFile = path.resolve("scripts/builders-nft/config/symmio-builders-nft-v1.baseline.json")

	it("verifies a private-key environment signer without persisting the key", async () => {
		const wallet = ethers.Wallet.createRandom()
		const environmentVariable = "BUILDERS_NFT_TEST_PRIVATE_KEY"
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "builders-nft-signer-"))
		const stateFile = path.join(temporaryDirectory, "state.json")
		const state = bindRolloutState({}, { chainId: 31337, networkName: "hardhat", configFile })
		process.env[environmentVariable] = wallet.privateKey
		try {
			const signer = await resolveConfiguredSigner({
				role: "testSigner",
				config: { type: "privateKeyEnv", address: wallet.address, privateKeyEnv: environmentVariable },
				provider: ethers.provider,
				state,
				stateFile,
			})
			expect(await signer.getAddress()).to.equal(wallet.address)
			const persisted = fs.readFileSync(stateFile, "utf8")
			expect(persisted).not.to.include(wallet.privateKey)
			expect(loadRolloutState(stateFile).signers?.testSigner).to.include({
				address: wallet.address,
				type: "privateKeyEnv",
				privateKeyEnv: environmentVariable,
			})
		} finally {
			delete process.env[environmentVariable]
		}
	})

	it("rejects a private key that does not match the configured signer", async () => {
		const expected = ethers.Wallet.createRandom()
		const supplied = ethers.Wallet.createRandom()
		const environmentVariable = "BUILDERS_NFT_TEST_MISMATCH_KEY"
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "builders-nft-signer-"))
		process.env[environmentVariable] = supplied.privateKey
		try {
			let failure: Error | undefined
			try {
				await resolveConfiguredSigner({
					role: "testSigner",
					config: { type: "privateKeyEnv", address: expected.address, privateKeyEnv: environmentVariable },
					provider: ethers.provider,
					state: {},
					stateFile: path.join(temporaryDirectory, "state.json"),
				})
			} catch (error) {
				failure = error as Error
			}
			expect(failure?.message).to.include("derives")
		} finally {
			delete process.env[environmentVariable]
		}
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
		expect(config.schemaVersion).to.equal(2)
		expect(config.signers.deployer).to.include({
			type: "privateKeyEnv",
			privateKeyEnv: "BUILDERS_NFT_DEPLOYER_PRIVATE_KEY",
		})
		expect(config.signers.nftProxyAdminOwner).to.include({
			type: "privateKeyEnv",
			privateKeyEnv: "BUILDERS_NFT_NFT_ADMIN_PRIVATE_KEY",
		})
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
