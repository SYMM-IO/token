import { upgrades as createUpgrades } from "@openzeppelin/hardhat-upgrades"
import hre from "hardhat"

export { hre }
export const connection = await hre.network.getOrCreate()
export const { ethers, networkHelpers } = connection
export const artifacts = hre.artifacts
export const network = connection
export const upgrades = await createUpgrades(hre, connection)
