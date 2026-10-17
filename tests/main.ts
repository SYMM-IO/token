import { shouldBehaveLikeSymmioBuildersNft } from "./symmioBuildersNft.behavior"
import { shouldBehaveLikeSymmioBuildersNftManager } from "./symmioBuildersNftManager.behavior"
import { shouldBehaveLikeSymmioBuildersNftPledge } from "./symmioBuildersNftPledge.behavior"

describe("Symmio Builders NFT system", () => {
	describe("SymmioBuildersNft", () => {
		shouldBehaveLikeSymmioBuildersNft()
	})

	describe("SymmioBuildersNftManager", () => {
		shouldBehaveLikeSymmioBuildersNftManager()
	})

	describe("NFT pledge custody", () => {
		shouldBehaveLikeSymmioBuildersNftPledge()
	})
})
