using System.Buffers.Binary;
using System.IO.Compression;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class MalformedRecordDiagnosisTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, 8, false)]
    [InlineData(GameRelease.Fallout4, 2, true)]
    [InlineData(GameRelease.SkyrimSE, 2, false)]
    [InlineData(GameRelease.SkyrimSE, 8, true)]
    public void EntryPointShape_IsTheGamesOwnVanillaShape_Function14TakesAnActorValueFormInFallout4AndAnIndexInSkyrim(
        GameRelease release, byte epft, bool diagnosed)
    {
        var record = Record("PERK", 0x000A725C,
            Subrecord("PRKE", [2, 0, 0]),
            Subrecord("DATA", [0, 14, 0]),
            Subrecord("EPFT", [epft]),
            Subrecord("EPFD", new byte[8]),
            Subrecord("PRKF", []));

        Assert.Equal(diagnosed, Scan(record, release).Count == 1);
    }

    [Fact]
    public void FixedSize_ASkyrimRegionsShortRdat_IsDiagnosed()
    {
        var record = Record("REGN", 0x00000001, Subrecord("EDID", "ShortRegion\0"u8.ToArray()), Subrecord("RDAT", new byte[6]));

        var d = Assert.Single(Scan(record, GameRelease.SkyrimSE));
        Assert.Equal("fixed-size-subrecord-short", d.DefectClass);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", d.Message);
    }

    private static List<PluginDiagnosis> Scan(byte[] bytes, GameRelease release = GameRelease.Fallout4)
    {
        using var folder = new ScratchDirectory("malformed-scan");
        var path = Path.Combine(folder.Path, "scanned.esp");
        File.WriteAllBytes(path, bytes);
        return [.. TestAdapters.Mutagen().ClaimOf(path, release).Answered().Diagnoses.Answered()];
    }

    [Fact]
    public void ACompressedRecordDeclaringALengthItsBytesCannotInflateTo_IsSkippedWithoutAllocatingThatLength()
    {
        const int HalfAGigabyte = 0x20000000;
        var region = DeflatedRecord("REGN", 0x00000001, CompressionLevel.Optimal, Subrecord("RDAT", new byte[6]));
        BinaryPrimitives.WriteInt32LittleEndian(region.AsSpan(24), HalfAGigabyte);
        var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();

        Assert.Empty(Scan(region));
        Assert.InRange(GC.GetAllocatedBytesForCurrentThread() - allocatedBefore, 0, HalfAGigabyte / 8);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    public void FixedCount_ARaceWithThirtyOneNames_IsDiagnosed(GameRelease release)
    {
        var names = Enumerable.Range(0, 31).Select(_ => Subrecord("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000002, [Subrecord("EDID", "ShortRace\0"u8.ToArray()), .. names]);

        var d = Assert.Single(Scan(record, release));
        Assert.Equal("fixed-count-list-wrong-count", d.DefectClass);
        Assert.Equal("RACE 00000002 (ShortRace)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("NAME appears 31 times; the Creation Kit always writes 32", d.Message);
    }

    [Fact]
    public void FixedCount_ARaceWithThirtyThreeNames_IsDiagnosedWithNoRepair_SinceNoByteSaysWhichNameAnotherToolAdded()
    {
        var names = Enumerable.Range(0, 33).Select(_ => Subrecord("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000002, [Subrecord("EDID", "LongRace\0"u8.ToArray()), .. names]);

        var d = Assert.Single(Scan(record));
        Assert.Equal("NAME appears 33 times; the Creation Kit always writes 32", d.Message);
        Assert.Null(d.Tail);
    }

    [Fact]
    public void CkOrder_TwoCombinationsEndingInADanglingObtfAndFull_IsDiagnosedWithNoRepair_SinceTheDanglingPairCouldBeEitherCombinations()
    {
        var record = Record("WEAP", 0x00000006,
            Subrecord("OBTE", U32(2)),
            Subrecord("OBTS", new byte[8]), Subrecord("OBTF", []), Subrecord("FULL", "A\0"u8.ToArray()),
            Subrecord("OBTS", new byte[8]), Subrecord("OBTF", []), Subrecord("FULL", "B\0"u8.ToArray()),
            Subrecord("STOP", []));

        var d = Assert.Single(Scan(record));
        Assert.Equal("subrecord-out-of-ck-order", d.DefectClass);
        Assert.Null(d.Tail);
    }

    public static TheoryData<string, byte[]> CleanShapes => new()
    {
        {
            "a vanilla-shaped entry point function 14",
            Record("PERK", 0x00000009,
                Subrecord("EDID", "CleanPerk\0"u8.ToArray()), Subrecord("PRKE", [2, 0, 0]), Subrecord("DATA", [0, 14, 0]),
                Subrecord("EPFT", [8]), Subrecord("EPFD", new byte[8]), Subrecord("PRKF", []))
        },
        {
            "an entry point function the shipped game never exercises, so no canonical shape is provable and the table makes no claim",
            Record("PERK", 0x0000000A,
                Subrecord("PRKE", [2, 0, 0]), Subrecord("DATA", [0, 4, 0]), Subrecord("EPFT", [1]), Subrecord("EPFD", new byte[4]), Subrecord("PRKF", []))
        },
        {
            "a fixed-size subrecord of its exact length",
            Record("REGN", 0x00000001, Subrecord("EDID", "CleanRegion\0"u8.ToArray()), Subrecord("RDAT", new byte[8]))
        },
        {
            "a race with all thirty-two names",
            Record("RACE", 0x00000003, [Subrecord("EDID", "CleanRace\0"u8.ToArray()), .. Enumerable.Repeat(Subrecord("NAME", "Slot\0"u8.ToArray()), 32)])
        },
        {
            "a counter and the entries it counts agreeing",
            Record("REFR", 0x00000005, Subrecord("XWPG", U32(2)), Subrecord("XWPN", new byte[12]), Subrecord("XWPN", new byte[12]))
        },
        {
            "a leading bare OBTS before closed combinations, the vanilla Gauss rifle's shape, proven canonical by the vanilla scan",
            Record("WEAP", 0x00000007,
                Subrecord("OBTE", U32(2)), Subrecord("OBTS", new byte[8]),
                Subrecord("OBTF", []), Subrecord("FULL", "A\0"u8.ToArray()), Subrecord("OBTS", new byte[8]), Subrecord("STOP", []))
        },
        { "a record of a type no table names", Record("MISC", 0x00000008, Subrecord("EDID", "Junk\0"u8.ToArray()), Subrecord("DATA", new byte[8])) },
    };

    [Theory]
    [MemberData(nameof(CleanShapes))]
    public void ACleanShape_ReportsNothing(string _, byte[] record)
    {
        Assert.Empty(Scan(record));
    }
}
