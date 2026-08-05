import { shouldBehaveLikeSymmioBuildersNft } from "./symmioBuildersNft.behavior"
import { shouldBehaveLikeSymmioBuildersNftManager } from "./symmioBuildersNftManager.behavior"

describe("Symmio Builders NFT system", () => {
	describe("SymmioBuildersNft", () => {
		shouldBehaveLikeSymmioBuildersNft()
	})

	describe("SymmioBuildersNftManager", () => {
		shouldBehaveLikeSymmioBuildersNftManager()
	})
})
