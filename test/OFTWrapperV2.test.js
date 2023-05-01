const { expect } = require("chai")
const { ethers } = require("hardhat")
const { BigNumber } = require("ethers")

describe("OFTWrapperV2:", function () {
    const chainIdSrc = 1
    const chainIdDst = 2
    const sharedDecimals = 6
    const name = "OmnichainFungibleToken"
    const symbol = "OFT"
    const partnerId = "0x0003"

    let owner, caller, badUser, OftWrapper, oftWrapper, LZEndpointMock, lzEndpointSrcMock, lzEndpointDstMock
    let OFTV2, OFTSrc, OFTDst, dstPath, srcPath, BP_DENOMINATOR, MAX_UINT

    before(async function () {
        ;[owner, caller, badUser] = await ethers.getSigners()

        LZEndpointMock = await ethers.getContractFactory("LZEndpointMock")
        OftWrapper = await ethers.getContractFactory("OFTWrapper")
        OFTV2 = await ethers.getContractFactory("MockOFTV2")
    })

    beforeEach(async function () {
        const OftWrapper = await ethers.getContractFactory("OFTWrapper")
        oftWrapper = await OftWrapper.deploy([0])

        lzEndpointSrcMock = await LZEndpointMock.deploy(chainIdSrc)
        lzEndpointDstMock = await LZEndpointMock.deploy(chainIdDst)

        OFTSrc = await OFTV2.deploy(name, symbol, sharedDecimals, lzEndpointSrcMock.address)
        OFTDst = await OFTV2.deploy(name, symbol, sharedDecimals, lzEndpointDstMock.address)

        // internal bookkeeping for endpoints (not part of a real deploy, just for this test)
        lzEndpointSrcMock.setDestLzEndpoint(OFTDst.address, lzEndpointDstMock.address)
        lzEndpointDstMock.setDestLzEndpoint(OFTSrc.address, lzEndpointSrcMock.address)

        BP_DENOMINATOR = await oftWrapper.BPS_DENOMINATOR()
        MAX_UINT = await oftWrapper.MAX_UINT()

        // set each contracts source address so it can send to each other
        dstPath = ethers.utils.solidityPack(["address", "address"], [OFTDst.address, OFTSrc.address])
        srcPath = ethers.utils.solidityPack(["address", "address"], [OFTSrc.address, OFTDst.address])
        await OFTSrc.setTrustedRemote(chainIdDst, dstPath) // for A, set B
        await OFTDst.setTrustedRemote(chainIdSrc, srcPath) // for B, set A
    })

    it("sendOFTV2()", async function () {
        let amountToMint = BigNumber.from("1000000000000000000000000")
        let amountToSwap = BigNumber.from("100000000000000")
        let defaultBps = 1000
        let callerBps = 100
        let feeObj = { callerBps, caller: caller.address, partnerId }
        const bytes32ToAddress = ethers.utils.defaultAbiCoder.encode(["address"], [owner.address])

        await oftWrapper.setDefaultBps(defaultBps)

        await OFTSrc.mint(owner.address, amountToMint)

        expect(await OFTSrc.balanceOf(owner.address)).to.be.equal(amountToMint)
        expect(await OFTDst.balanceOf(owner.address)).to.be.equal(0)
        expect(await OFTDst.balanceOf(caller.address)).to.be.equal(0)
        expect(await OFTDst.balanceOf(oftWrapper.address)).to.be.equal(0)

        await OFTSrc.approve(oftWrapper.address, amountToSwap)

        const lzFee = (await oftWrapper.estimateSendFeeV2(OFTSrc.address, chainIdDst, bytes32ToAddress, amountToSwap, false, "0x", feeObj))
            .nativeFee

        let { amount, wrapperFee, callerFee } = await oftWrapper.getAmountAndFees(OFTSrc.address, amountToSwap, callerBps)

        await oftWrapper.sendOFTV2(
            OFTSrc.address,
            chainIdDst,
            bytes32ToAddress,
            amountToSwap,
            0,
            [owner.address, ethers.constants.AddressZero, "0x"],
            feeObj,
            { value: lzFee }
        )

        expect(await OFTSrc.balanceOf(owner.address)).to.be.equal(amountToMint.sub(amountToSwap))
        expect(await OFTDst.balanceOf(owner.address)).to.be.equal(amount)
        expect(await OFTSrc.balanceOf(caller.address)).to.be.equal(callerFee)
        expect(await OFTSrc.balanceOf(oftWrapper.address)).to.be.equal(wrapperFee)
    })

    it("sendOFTV2() - OFTWrapper: amountToSwap < minAmount", async function () {
        let amountToMint = BigNumber.from("1000000000000000000000000")
        let amountToSwap = BigNumber.from("100000000000000")
        let defaultBps = 1
        let callerBps = 0
        let feeObj = { callerBps, caller: caller.address, partnerId }
        const bytes32ToAddress = ethers.utils.defaultAbiCoder.encode(["address"], [owner.address])

        await oftWrapper.setDefaultBps(defaultBps)
        await OFTSrc.mint(owner.address, amountToMint)
        await OFTSrc.approve(oftWrapper.address, amountToSwap)
        const lzFee = (await oftWrapper.estimateSendFeeV2(OFTSrc.address, chainIdDst, bytes32ToAddress, amountToSwap, false, "0x", feeObj))
            .nativeFee

        let { amount } = await oftWrapper.getAmountAndFees(OFTSrc.address, amountToSwap, callerBps)

        expect(amount).to.be.lt(amountToSwap)

        await expect(
            oftWrapper.sendOFTV2(
                OFTSrc.address,
                chainIdDst,
                bytes32ToAddress,
                amountToSwap,
                amountToSwap,
                [owner.address, ethers.constants.AddressZero, "0x"],
                feeObj,
                { value: lzFee }
            )
        ).to.be.revertedWith("OFTWrapper: not enough amountToSwap")
    })

    it("withdrawFees()", async function () {
        let amountToMint = BigNumber.from("1000000000000000000000000")
        let amountToSwap = BigNumber.from("100000000000000")
        let defaultBps = 1000
        let callerBps = 100
        let feeObj = { callerBps, caller: caller.address, partnerId }
        const bytes32ToAddress = ethers.utils.defaultAbiCoder.encode(["address"], [owner.address])

        await oftWrapper.setDefaultBps(defaultBps)
        await OFTSrc.mint(owner.address, amountToMint)
        await OFTSrc.approve(oftWrapper.address, amountToSwap)
        const lzFee = (await oftWrapper.estimateSendFeeV2(OFTSrc.address, chainIdDst, bytes32ToAddress, amountToSwap, false, "0x", feeObj))
            .nativeFee

        let { amount, wrapperFee, callerFee } = await oftWrapper.getAmountAndFees(OFTSrc.address, amountToSwap, callerBps)

        await oftWrapper.sendOFTV2(
            OFTSrc.address,
            chainIdDst,
            bytes32ToAddress,
            amountToSwap,
            0,
            [owner.address, ethers.constants.AddressZero, "0x"],
            feeObj,
            { value: lzFee }
        )

        expect(await OFTSrc.balanceOf(oftWrapper.address)).to.be.equal(wrapperFee)
        expect(await OFTSrc.balanceOf(owner.address)).to.be.equal(amountToMint.sub(amountToSwap))
        expect(await OFTDst.balanceOf(owner.address)).to.be.equal(amount)
        expect(await OFTSrc.balanceOf(caller.address)).to.be.equal(callerFee)
        await oftWrapper.withdrawFees(OFTSrc.address, owner.address, wrapperFee)
        expect(await OFTSrc.balanceOf(owner.address)).to.be.equal(amountToMint.sub(amountToSwap).add(wrapperFee))
    })
})