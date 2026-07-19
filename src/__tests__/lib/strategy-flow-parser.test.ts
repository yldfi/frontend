import { describe, it, expect } from "vitest";
import { parseStrategySource, generateFlowSteps } from "@/lib/strategy-flow/parser";

// Sample contract snippets for testing
const CVXCRV_COMPOUNDER_SNIPPET = `
contract CvxCrvCompounder is BaseStrategy, AuctionSwapper {
    using SafeERC20 for IERC20;

    ICvxCrvStakingWrapper public constant WRAPPER = ICvxCrvStakingWrapper(0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434);

    constructor(address _asset, string memory _name) BaseStrategy(_asset, _name) {
        IERC20(address(asset)).forceApprove(address(WRAPPER), type(uint256).max);
    }

    function _deployFunds(uint256 _amount) internal override {
        WRAPPER.stake(_amount, address(this));
    }

    function _freeFunds(uint256 _amount) internal override {
        WRAPPER.withdraw(Math.min(_amount, WRAPPER.balanceOf(address(this))));
    }

    function _harvestAndReport() internal virtual override returns (uint256 _totalAssets) {
        _claimRewards();
        uint256 assetBal = asset.balanceOf(address(this));
        if (assetBal > 0 && !TokenizedStrategy.isShutdown() && !WRAPPER.isShutdown()) {
            _deployFunds(assetBal);
        }
        return asset.balanceOf(address(this)) + WRAPPER.balanceOf(address(this));
    }

    function _claimRewards() internal {
        WRAPPER.getReward(address(this));
    }
}

contract AuctionSwapper is BaseSwapper {
    address public auction;
    bool public useAuction;
    function kickAuction(address _from) external virtual returns (uint256) {}
}
`;

const STKCVGCVX_SNIPPET = `
contract StkCVGCVXStrategy is BaseStrategy {
    using SafeERC20 for ERC20;

    ICvgCvxStaking public constant STAKING = ICvgCvxStaking(0x2c1D293c50C6d1a4370ebb442A02c5956bbAb119);

    constructor(address _asset, string memory _name) BaseStrategy(_asset, _name) {
        asset.forceApprove(address(STAKING), type(uint256).max);
    }

    function _deployFunds(uint256 _amount) internal override {
        STAKING.deposit(_amount, ICvgCvxStaking.IN_TOKEN_TYPE.cvgCVX, 0, 0, false);
    }

    function _freeFunds(uint256 _amount) internal override {
        STAKING.withdraw(_amount, ICvgCvxStaking.OUT_TOKEN_TYPE.cvgCVX, 0);
    }

    function _harvestAndReport() internal virtual override returns (uint256 _totalAssets) {
        STAKING.claimCvgCvxRewards(address(this), 0, false);
        uint256 idleBalance = asset.balanceOf(address(this));
        if (idleBalance > 0 && !TokenizedStrategy.isShutdown()) {
            _deployFunds(idleBalance);
        }
        return asset.balanceOf(address(this)) + STAKING.balanceOf(address(this));
    }
}
`;

const PXCVX_COMPOUNDER_SNIPPET = `
contract PxCVXCompounder is BaseStrategy {
    using SafeERC20 for IERC20;

    IPxCvx public constant PXCVX = IPxCvx(0xBCe0Cf87F513102F22232436CCa2ca49e815C3aC);
    IPirexCvx public constant PIREX_CVX = IPirexCvx(0x35A398425d9f1029021A92bc3d2557D42C8588D7);

    address public immutable auction;

    constructor(
        address _asset,
        string memory _name,
        address _auctionFactory
    ) BaseStrategy(_asset, _name) {
        require(_asset == address(PXCVX), "Asset must be pxCVX");
        auction = IAuctionFactory(_auctionFactory).createNewAuction(
            address(PXCVX),
            address(this),
            address(this)
        );
    }

    function _deployFunds(uint256 /*_amount*/) internal override {
        // pxCVX just sits in strategy, no staking needed
    }

    function _freeFunds(uint256 /*_amount*/) internal override {
        // Nothing to unstake, pxCVX is liquid
    }

    function _harvestAndReport() internal override returns (uint256 _totalAssets) {
        _claimRewards();
        return asset.balanceOf(address(this));
    }

    function _claimRewards() internal {
        // Claim Votium rewards
        PIREX_CVX.claimVotiumRewards();
    }

    function kickAuction(address _token) external returns (uint256 kicked) {
        require(_token != address(asset), "Cannot auction strategy asset");
        kicked = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(auction, kicked);
        IAuction(auction).kick(_token);
    }

    function auctionTrigger(address _from) external view returns (bool, bytes memory) {
        return (true, abi.encodeCall(this.kickAuction, (_from)));
    }
}
`;

// Mirrors the real deployed ysCVX strategy (0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e):
// asset is validated via `if (_asset != address(POOL.stakingToken())) revert(...)`
// (not the `require(_asset == address(X))` style the other snippets use), and
// the reward token constant CVXCRV shares a name prefix with the asset's own
// family, which used to make the parser misdetect the asset as cvxCRV.
const CVX_COMPOUNDER_SNIPPET = `
contract CVXCompounder is BaseStrategy, AuctionSwapper {
    using SafeERC20 for IERC20;

    ICvxRewardPool public constant CVX_REWARD_POOL = ICvxRewardPool(0xCF50b810E57Ac33B91dCF525C6ddd9881B139332);
    address public constant CVXCRV = 0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7;

    constructor(address _asset, string memory _name) BaseStrategy(_asset, _name) {
        if (_asset != address(CVX_REWARD_POOL.stakingToken())) revert InvalidAsset();
        IERC20(_asset).forceApprove(address(CVX_REWARD_POOL), type(uint256).max);
    }

    function _deployFunds(uint256 _amount) internal override {
        CVX_REWARD_POOL.stake(_amount);
    }

    function _freeFunds(uint256 _amount) internal override {
        CVX_REWARD_POOL.withdraw(Math.min(_amount, CVX_REWARD_POOL.balanceOf(address(this))), false);
    }

    function _harvestAndReport() internal override returns (uint256 _totalAssets) {
        // Claim cvxCRV rewards
        CVX_REWARD_POOL.getReward(address(this), false, false);
        uint256 idleBalance = asset.balanceOf(address(this));
        if (idleBalance > 0 && !TokenizedStrategy.isShutdown()) {
            _deployFunds(idleBalance);
        }
        _totalAssets = CVX_REWARD_POOL.balanceOf(address(this)) + asset.balanceOf(address(this));
    }

    function kickable(address _token) public view override returns (uint256) {
        if (_token != CVXCRV) return 0;
        return super.kickable(_token);
    }
}

contract AuctionSwapper is BaseSwapper {
    address public auction;
    bool public useAuction;
    function kickAuction(address _from) external virtual returns (uint256) {}
}
`;

describe("Strategy Flow Parser", () => {
  describe("CvxCrvCompounder (AuctionSwapper inheritance)", () => {
    it("should parse correctly", () => {
      const result = parseStrategySource(
        CVXCRV_COMPOUNDER_SNIPPET,
        "0xCa960E6DF1150100586c51382f619efCCcF72706",
        "CvxCrvCompounder",
        "v0.8.23"
      );

      expect(result.success).toBe(true);
      expect(result.config).not.toBeNull();
      expect(result.config!.name).toBe("CvxCrvCompounder");
      expect(result.config!.inherits.baseStrategy).toBe(true);
      expect(result.config!.inherits.auctionSwapper).toBe(true);
      expect(result.config!.compounding.mechanism).toBe("auction");
    });

    it("should detect yield source", () => {
      const result = parseStrategySource(
        CVXCRV_COMPOUNDER_SNIPPET,
        "0xCa960E6DF1150100586c51382f619efCCcF72706",
        "CvxCrvCompounder",
        "v0.8.23"
      );

      expect(result.config!.yieldSource.name).toBe("WRAPPER");
      expect(result.config!.yieldSource.depositFn).toBe("stake");
      expect(result.config!.yieldSource.withdrawFn).toBe("withdraw");
      expect(result.config!.yieldSource.claimFn).toBe("getReward");
    });

    it("should generate correct flow steps", () => {
      const result = parseStrategySource(
        CVXCRV_COMPOUNDER_SNIPPET,
        "0xCa960E6DF1150100586c51382f619efCCcF72706",
        "CvxCrvCompounder",
        "v0.8.23"
      );

      const flow = generateFlowSteps(result.config!);

      expect(flow.cycleSteps).toContain("auction");
      expect(flow.cycleSteps).toContain("receive");
      expect(flow.cycleSteps).toContain("claim");
    });
  });

  describe("StkCVGCVXStrategy (direct compound)", () => {
    it("should parse correctly", () => {
      const result = parseStrategySource(
        STKCVGCVX_SNIPPET,
        "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359",
        "StkCVGCVXStrategy",
        "v0.8.23"
      );

      expect(result.success).toBe(true);
      expect(result.config).not.toBeNull();
      expect(result.config!.name).toBe("StkCVGCVXStrategy");
      expect(result.config!.inherits.baseStrategy).toBe(true);
      expect(result.config!.inherits.auctionSwapper).toBe(false);
    });

    it("should detect direct compounding", () => {
      const result = parseStrategySource(
        STKCVGCVX_SNIPPET,
        "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359",
        "StkCVGCVXStrategy",
        "v0.8.23"
      );

      // This strategy rewards cvgCVX which is the same as asset - direct compound
      expect(result.config!.compounding.mechanism).toBe("direct");
    });

    it("should generate flow without auction steps", () => {
      const result = parseStrategySource(
        STKCVGCVX_SNIPPET,
        "0x8ED5AB1BA2b2E434361858cBD3CA9f374e8b0359",
        "StkCVGCVXStrategy",
        "v0.8.23"
      );

      const flow = generateFlowSteps(result.config!);

      expect(flow.cycleSteps).not.toContain("auction");
      expect(flow.cycleSteps).not.toContain("receive");
    });
  });

  describe("PxCVXCompounder (custom auction)", () => {
    it("should parse correctly", () => {
      const result = parseStrategySource(
        PXCVX_COMPOUNDER_SNIPPET,
        "0xB246DB2A73EEE3ee026153660c74657C123f8E42",
        "PxCVXCompounder",
        "v0.8.23"
      );

      expect(result.success).toBe(true);
      expect(result.config).not.toBeNull();
      expect(result.config!.name).toBe("PxCVXCompounder");
    });

    it("should detect custom auction implementation", () => {
      const result = parseStrategySource(
        PXCVX_COMPOUNDER_SNIPPET,
        "0xB246DB2A73EEE3ee026153660c74657C123f8E42",
        "PxCVXCompounder",
        "v0.8.23"
      );

      // Should detect auction via custom implementation, not inheritance
      expect(result.config!.inherits.auctionSwapper).toBe(true); // Detected via custom auction
      expect(result.config!.compounding.mechanism).toBe("auction");
    });

    it("should detect pxCVX as asset", () => {
      const result = parseStrategySource(
        PXCVX_COMPOUNDER_SNIPPET,
        "0xB246DB2A73EEE3ee026153660c74657C123f8E42",
        "PxCVXCompounder",
        "v0.8.23"
      );

      expect(result.config!.asset.symbol).toBe("pxCVX");
    });

    it("should detect pass-through (no staking)", () => {
      const result = parseStrategySource(
        PXCVX_COMPOUNDER_SNIPPET,
        "0xB246DB2A73EEE3ee026153660c74657C123f8E42",
        "PxCVXCompounder",
        "v0.8.23"
      );

      // pxCVX sits directly in strategy, no external staking
      expect(result.config!.yieldSource.depositFn).toBe("hold");
    });
  });

  describe("CVXCompounder (asset validated via pool.stakingToken(), not require(_asset==))", () => {
    it("detects CVX as the asset, not the cvxCRV reward-token constant", () => {
      const result = parseStrategySource(
        CVX_COMPOUNDER_SNIPPET,
        "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
        "CVXCompounder",
        "v0.8.28"
      );

      expect(result.success).toBe(true);
      // Regression: the parser used to have no "CVX" case at all and only
      // matched the require(_asset == address(X)) constructor style, so it
      // fell through to a whole-source scan and grabbed "cvxCRV" (the reward
      // token constant) as the asset instead — mislabeling the entire vault
      // as "yscvxCRV" everywhere in the generated diagram.
      expect(result.config!.asset.symbol).toBe("CVX");
    });

    it("reports cvxCRV as the sole reward token, not CVX and CRV separately", () => {
      const result = parseStrategySource(
        CVX_COMPOUNDER_SNIPPET,
        "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
        "CVXCompounder",
        "v0.8.28"
      );

      // Regression: with the asset misdetected as "cvxCRV", the real reward
      // (cvxCRV) got skipped as "same as asset" and the generic CRV/CVX
      // substring matches were added instead, showing "CRV + CVX" as two
      // separate rewards.
      expect(result.config!.rewards.tokens).toEqual(["cvxCRV"]);
    });

    it("detects the auction compounding mechanism", () => {
      const result = parseStrategySource(
        CVX_COMPOUNDER_SNIPPET,
        "0x1Fd0A85084fC61c397AC619c4F0bA2350eA1cE9e",
        "CVXCompounder",
        "v0.8.28"
      );

      expect(result.config!.compounding.mechanism).toBe("auction");
    });
  });
});
