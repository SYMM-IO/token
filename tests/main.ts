import { shouldBehaveLikeSymmioBuildersNft } from "./symmioBuildersNft.behavior.js"
import { shouldBehaveLikeSymmioBuildersNftManager } from "./symmioBuildersNftManager.behavior.js"

describe("Symmio Builders NFT system", () => {
	describe("SymmioBuildersNft", () => {
		shouldBehaveLikeSymmioBuildersNft()
	})

	describe("SymmioBuildersNftManager", () => {
		shouldBehaveLikeSymmioBuildersNftManager()
	})
})
