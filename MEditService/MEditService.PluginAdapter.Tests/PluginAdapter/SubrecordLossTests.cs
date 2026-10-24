using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class SubrecordLossTests : IDisposable
{
    private const int RecordHeaderLength = 24;
    private const ushort NoFormVersion = 0;

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _folder = new("subrecord-loss");

    public void Dispose() => _folder.Dispose();

    private async Task<PluginByteComparison> ComparisonAsync(byte[] original, byte[] rewritten, LoadOrderSnapshot? loadOrder = null)
    {
        var originalPath = Path.Combine(_folder.Path, "original.esp");
        var rewrittenPath = Path.Combine(_folder.Path, "rewritten.esp");
        File.WriteAllBytes(originalPath, WithHeader(original));
        File.WriteAllBytes(rewrittenPath, WithHeader(rewritten));
        return (await Adapter.CompareBytesAsync(originalPath, rewrittenPath, loadOrder ?? EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();
    }

    private async Task<PluginBinaryWalk.SubrecordLoss?> LossAsync(byte[] original, byte[] rewritten, LoadOrderSnapshot? loadOrder = null) =>
        (await ComparisonAsync(original, rewritten, loadOrder)).Loss;

    private static byte[] WithHeader(byte[] records) =>
        Encoding.ASCII.GetString(records, 0, 4) == "TES4" ? records : Concat(Tes4(), records);

    private static byte[] Header(params byte[][] subrecords) => Record("TES4", 0, 0, NoFormVersion, subrecords);

    private static (byte[] Original, byte[] Rewritten) OwnRecordAndOverrideOfB_SwappingRawFormIds_AsTheRewritePrunesA(params byte[][] ownSubrecordsAfter)
    {
        byte[][] own = [Subrecord("EDID", "Own"u8.ToArray()), Subrecord("RDMP", [1])];
        byte[][] overrideOfB = [Subrecord("EDID", "OverrideOfB"u8.ToArray()), Subrecord("RDMP", [2]), Subrecord("RDMO", [3])];
        var original = Concat(Tes4(masters: ["A.esm", "B.esm"]), Record("WEAP", 0x02000801, own), Record("WEAP", 0x01000801, overrideOfB));
        var rewritten = Concat(Tes4(masters: ["B.esm"]), Record("WEAP", 0x01000801, ownSubrecordsAfter), Record("WEAP", 0x00000801, overrideOfB));
        return (original, rewritten);
    }

    private static byte[] CompressedPayload(params byte[][] subrecords) => DeflatedRecord("REGN", 0x42, CompressionLevel.Optimal, subrecords)[RecordHeaderLength..];

    private static byte[] Unreadable(byte[] compressedPayload) => Record("REGN", 0x42, (uint)CompressedFlag.Bit, NoFormVersion, compressedPayload);

    private static readonly byte[] UnreadableAfterADeclaredLengthPastAnInt =
        Unreadable([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03]);

    private static readonly byte[] UnreadableAfterADeclaredLengthNoArrayHolds =
        Unreadable([.. U32(0x7FFFFFF0), .. CompressedPayload(Subrecord("EDID", [1]))[4..]]);

    private static readonly byte[] UnreadableAsNoZlibStream = Unreadable([0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03]);

    private static readonly byte[] UnreadableAsShorterThanItsDeclaredLength =
        Unreadable([.. U32(64), .. CompressedPayload(Subrecord("EDID", [1]))[4..]]);

    private static readonly byte[] AnEmptyWeapon = Record("WEAP", 0x00000802);

    private static readonly (byte[] Original, byte[] Rewritten) UnchangedWhenTheRewritePrunesAMaster =
        OwnRecordAndOverrideOfB_SwappingRawFormIds_AsTheRewritePrunesA(Subrecord("EDID", "Own"u8.ToArray()), Subrecord("RDMP", [1]));

    public static TheoryData<string, byte[], byte[]> NotReportedAsLoss => new()
    {
        { "an unchanged record, when the rewrite prunes a master", UnchangedWhenTheRewritePrunesAMaster.Original, UnchangedWhenTheRewritePrunesAMaster.Rewritten },
        {
            "a signature with more occurrences in the rewrite",
            Record("FURN", 1, Subrecord("EDID", "Furniture"u8.ToArray())),
            Record("FURN", 1, Subrecord("EDID", "Furniture"u8.ToArray()), Subrecord("FNAM", [0, 0]), Subrecord("MNAM", [0, 0]))
        },
        { "a reorder", Record("WEAP", 1, Subrecord("EDID", [1]), Subrecord("RCLR", [2])), Record("WEAP", 1, Subrecord("RCLR", [2]), Subrecord("EDID", [1])) },
        { "a content change of the same count", Record("WEAP", 1, Subrecord("RCLR", [0x0A, 0x0F, 0xC8, 0x00])), Record("WEAP", 1, Subrecord("RCLR", [0xFF, 0x00, 0x00, 0x00])) },
        {
            "a structural divergence of record type, rather than a misdiagnosis",
            Record("WEAP", 1, Subrecord("EDID", "Gun"u8.ToArray()), Subrecord("FULL", "Name"u8.ToArray())),
            Record("ARMO", 1, Subrecord("EDID", "Gun"u8.ToArray()))
        },
        {
            "a structural divergence of compression, rather than a misdiagnosis",
            Record("REGN", 0x42, Subrecord("EDID", "Region"u8.ToArray()), Subrecord("RDMP", [1])),
            Record("REGN", 0x42, (uint)CompressedFlag.Bit, NoFormVersion, CompressedPayload(Subrecord("EDID", "Region"u8.ToArray())))
        },
        { "an unreadable compressed record, its declared length past an int", UnreadableAfterADeclaredLengthPastAnInt, Concat(UnreadableAfterADeclaredLengthPastAnInt, AnEmptyWeapon) },
        { "an unreadable compressed record, its declared length more than an array holds", UnreadableAfterADeclaredLengthNoArrayHolds, Concat(UnreadableAfterADeclaredLengthNoArrayHolds, AnEmptyWeapon) },
        { "an unreadable compressed record, its stream not zlib", UnreadableAsNoZlibStream, Concat(UnreadableAsNoZlibStream, AnEmptyWeapon) },
        { "an unreadable compressed record, its stream shorter than its declared length", UnreadableAsShorterThanItsDeclaredLength, Concat(UnreadableAsShorterThanItsDeclaredLength, AnEmptyWeapon) },
        {
            "a drop of the TES4's MAST and DATA alone",
            Header(Subrecord("HEDR", [1, 2, 3, 4]), Subrecord("MAST", "Fallout4.esm\0"u8.ToArray()), Subrecord("DATA", new byte[8])),
            Header(Subrecord("HEDR", [1, 2, 3, 4]))
        },
    };

    [Theory]
    [MemberData(nameof(NotReportedAsLoss))]
    public async Task ARewrite_TheComparisonDoesNotCountAsLoss_ReportsNone(string _, byte[] original, byte[] rewritten)
    {
        Assert.Null(await LossAsync(original, rewritten));
    }

    [Fact]
    public async Task WhenTheRewritePrunesAMaster_ADropInThePluginsOwnRecordIsNamedByItsFormKey()
    {
        var (original, rewritten) = OwnRecordAndOverrideOfB_SwappingRawFormIds_AsTheRewritePrunesA(Subrecord("EDID", "Own"u8.ToArray()));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(("WEAP", "000801:original.esp"), (loss?.RecordType, loss?.FormKey.ToString()));
        Assert.Equal(["RDMP"], loss?.Signatures);
    }

    [Fact]
    public async Task InAGameThatSeparatesLightMasters_ADropInAnOverrideOfALightMastersRecordIsNamedByThatMastersFormKey()
    {
        const uint LightMasterZerosObjectId801 = 0xFE000801;
        var (masterPath, _) = LightMasterAndChild.Write(_folder.Path);
        var loadOrder = SnapshotPlugins.Snapshot(_folder.Path, null, GameRelease.Starfield,
            [new LoadOrderEntry(LightMasterAndChild.Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)]);
        var overridingTheLightMaster = Tes4(masters: [LightMasterAndChild.Master.FileName]);
        var original = Concat(overridingTheLightMaster,
            Record("WEAP", LightMasterZerosObjectId801, Subrecord("EDID", "Gun"u8.ToArray()), Subrecord("RDMP", [1])));
        var rewritten = Concat(overridingTheLightMaster, Record("WEAP", LightMasterZerosObjectId801, Subrecord("EDID", "Gun"u8.ToArray())));

        var loss = await LossAsync(original, rewritten, loadOrder);

        Assert.Equal(LightMasterAndChild.Weapon, loss?.FormKey);
    }

    [Fact]
    public async Task ADeletedRecordWhoseRewriteHoldsNoSubrecord_IsNamedBySignatureAndFormKey()
    {
        var original = Record("REFR", 0x00000801, (uint)DeletedFlag.Bit, NoFormVersion, Subrecord("NAME", [1, 2, 3, 4]));
        var rewritten = Record("REFR", 0x00000801, (uint)DeletedFlag.Bit, NoFormVersion);

        Assert.Equal("REFR 000801:original.esp", (await ComparisonAsync(original, rewritten)).DeletedRecordEmptied);
    }

    [Fact]
    public async Task ADeletedRecordWhoseRewriteKeepsItsSubrecords_IsNotNamed()
    {
        var deleted = Record("WRLD", 0x00000801, (uint)DeletedFlag.Bit, NoFormVersion, Subrecord("EDID", "World"u8.ToArray()));

        Assert.Null((await ComparisonAsync(deleted, Concat(deleted, AnEmptyWeapon))).DeletedRecordEmptied);
    }

    [Fact]
    public async Task ARecordInsideAGrup_IsComparedByItsOwnHeader()
    {
        var original = Group("WEAP", Record("WEAP", 0x00123456, Subrecord("EDID", [1]), Subrecord("RDMP", [2])));
        var rewritten = Group("WEAP", Record("WEAP", 0x00123456, Subrecord("EDID", [1])));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(("WEAP", 0x00123456u), (loss?.RecordType, loss?.FormId));
    }

    private static byte[] SubrecordHeaderDeclaring(string signature, ushort declaredLength)
    {
        var header = new byte[6];
        Encoding.ASCII.GetBytes(signature).CopyTo(header, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4), declaredLength);
        return header;
    }

    [Fact]
    public async Task AnXxxxMarker_SuppliesTheFollowingSubrecordsRealLength()
    {
        const ushort DeliberatelyWrongDeclaredLengthSoOnlyTheXxxxMarkersOwnValueIsTheRealLength = 3;
        byte[] payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        var xxxxMarker = Subrecord("XXXX", U32((uint)payload.Length));
        var oversizedSubrecord = Concat(SubrecordHeaderDeclaring("BIG ", DeliberatelyWrongDeclaredLengthSoOnlyTheXxxxMarkersOwnValueIsTheRealLength), payload);
        var original = Record("WEAP", 1, xxxxMarker, oversizedSubrecord, Subrecord("RDMP", [1]));
        var rewritten = Record("WEAP", 1, xxxxMarker, oversizedSubrecord);

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(["RDMP"], loss?.Signatures);
    }

    [Fact]
    public async Task ASignatureWithFewerOccurrencesInTheRewrite_IsReported()
    {
        var original = Record("WEAP", 1, Subrecord("RDAT", [1]), Subrecord("RDAT", [2]), Subrecord("RDMP", [3]));
        var rewritten = Record("WEAP", 1, Subrecord("RDAT", [1]));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(["RDAT", "RDMP"], loss?.Signatures);
    }

    private static readonly byte[] AnUntouchedWeapon = Record("WEAP", 0x00000001, Subrecord("EDID", "Gun"u8.ToArray()));

    private static readonly byte[] ARegionRewrittenWithoutItsRdmpAndRdmo = Record("REGN", 0x00ABCDEF, Subrecord("EDID", "Region"u8.ToArray()));

    public static TheoryData<string, byte[]> RewritesShrinkingTheSecondRecord => new()
    {
        { "in the original's order", Concat(AnUntouchedWeapon, ARegionRewrittenWithoutItsRdmpAndRdmo) },
        { "in another order, as a rewrite from the tree carries no group order", Concat(ARegionRewrittenWithoutItsRdmpAndRdmo, AnUntouchedWeapon) },
    };

    [Theory]
    [MemberData(nameof(RewritesShrinkingTheSecondRecord))]
    public async Task TheLoss_NamesTheRecordWhoseInventoryShrank_PairedByTypeAndFormId_NotAnUnchangedOne(string _, byte[] rewritten)
    {
        var original = Concat(AnUntouchedWeapon,
            Record("REGN", 0x00ABCDEF, Subrecord("EDID", "Region"u8.ToArray()), Subrecord("RDMP", [1]), Subrecord("RDMO", [2])));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(("REGN", 0x00ABCDEFu), (loss?.RecordType, loss?.FormId));
        Assert.Equal(["RDMP", "RDMO"], loss?.Signatures);
    }

    [Fact]
    public async Task DecompressesACompressedRecordBeforeComparing()
    {
        var original = DeflatedRecord("REGN", 0x00000042, CompressionLevel.Optimal, Subrecord("EDID", "Compressed"u8.ToArray()), Subrecord("RDMP", [1]));
        var rewritten = DeflatedRecord("REGN", 0x00000042, CompressionLevel.Optimal, Subrecord("EDID", "Compressed"u8.ToArray()));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(["RDMP"], loss?.Signatures);
    }

    [Fact]
    public async Task ATes4NonMasterSubrecordDrop_IsStillReported()
    {
        var originalHeader = Header(
            Subrecord("HEDR", [1, 2, 3, 4]), Subrecord("MAST", "Fallout4.esm\0"u8.ToArray()), Subrecord("DATA", new byte[8]), Subrecord("SNAM", "desc"u8.ToArray()));
        var rewrittenHeader = Header(Subrecord("HEDR", [1, 2, 3, 4]), Subrecord("MAST", "Fallout4.esm\0"u8.ToArray()), Subrecord("DATA", new byte[8]));

        var loss = await LossAsync(originalHeader, rewrittenHeader);

        Assert.Equal("TES4", loss?.RecordType);
        Assert.Equal(["SNAM"], loss?.Signatures);
    }
}
