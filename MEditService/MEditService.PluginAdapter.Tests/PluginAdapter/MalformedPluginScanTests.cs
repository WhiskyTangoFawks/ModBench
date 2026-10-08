using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class MalformedPluginScanTests
{
    [Fact]
    public void ShortRegnRdat_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = Scan(ShortRdatRegionPlugin.Plugin.Bytes);

        var d = Assert.Single(diagnoses, d => d.DefectClass == "fixed-size-subrecord-short");
        Assert.Equal(ShortRdatRegionPlugin.Anchor, d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", d.Message);
    }

    [Fact]
    public void GaussRevolver_TemplateRotation_IsDiagnosedByExactClassAndText_TheCombinationsObtsPrecedingItsObtfAndFullLeavingThemUnclosed()
    {
        var diagnoses = Scan(Record("WEAP", 0x03000860,
            Subrecord("EDID", "GaussRevolver\0"u8.ToArray()),
            Subrecord("OBTE", U32(1)),
            Subrecord("OBTS", new byte[67]),
            Subrecord("OBTF", []), Subrecord("FULL", "Gauss Revolver\0"u8.ToArray()),
            Subrecord("STOP", [])));

        var d = Assert.Single(diagnoses);
        Assert.Equal("subrecord-out-of-ck-order", d.DefectClass);
        Assert.Equal("WEAP 03000860 (GaussRevolver)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS", d.Message);
    }

    [Fact]
    public void Lunar_BothShortBipedNameLists_31And30NamesWhereTheCkAlwaysWrites32_AreDiagnosedByExactClassAndText()
    {
        var diagnoses = Scan(Concat(
            RaceWithNames(0x03014174, "DLC03_FogCrawlerRace", 31),
            RaceWithNames(0x0603637A, "DLC04_GatorclawRace", 30)));

        Assert.Equal(2, diagnoses.Count);
        Assert.All(diagnoses, d => Assert.Equal("fixed-count-list-wrong-count", d.DefectClass));
        Assert.All(diagnoses, d => Assert.Equal("repairable (lossless)", d.Tail));
        var fogCrawler = Assert.Single(diagnoses, d => d.Anchor == "RACE 03014174 (DLC03_FogCrawlerRace)");
        Assert.Equal("NAME appears 31 times; the Creation Kit always writes 32", fogCrawler.Message);
        var gatorclaw = Assert.Single(diagnoses, d => d.Anchor == "RACE 0603637A (DLC04_GatorclawRace)");
        Assert.Equal("NAME appears 30 times; the Creation Kit always writes 32", gatorclaw.Message);
    }

    [Fact]
    public void SouthOfTheSea_CounterDisagreeingWithEntries_XwpgSaysOnePowerGridConnectionButTwoXwpnEntriesFollow_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = Scan(Record("REFR", 0x07431EDC,
            Subrecord("EDID", "00sots_Necropolis_WorkshopRef\0"u8.ToArray()),
            Subrecord("XWPG", U32(1)),
            Subrecord("XWPN", new byte[12]), Subrecord("XWPN", new byte[12])));

        var d = Assert.Single(diagnoses);
        Assert.Equal("counter-entries-mismatch", d.DefectClass);
        Assert.Equal("REFR 07431EDC (00sots_Necropolis_WorkshopRef)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("XWPG counts 1; 2 XWPN entries follow", d.Message);
    }

    [Fact]
    public void MisshapedPerk_WrongEpftForFunction14_IsDiagnosedByExactClassAndText_EntryZeroOfTheSamePerkIsCleanWhichPinsPerEntryIndexing()
    {
        var diagnoses = Scan(MisshapedPerkPlugin.Plugin.Bytes);

        var d = Assert.Single(diagnoses, d => d.DefectClass == "entry-point-parameter-shape");
        Assert.Equal(MisshapedPerkPlugin.Anchor, d.Anchor);
        var noRepairTailBecauseRetypingTheParameterIsASemanticMappingNotAByteOperation = d.Tail;
        Assert.Null(noRepairTailBecauseRetypingTheParameterIsASemanticMappingNotAByteOperation);
        Assert.Equal("entry point 1 (function 14, Multiply 1 + Actor Value Mult) has EPFT 2; vanilla writes EPFT 8", d.Message);
    }

    [Fact]
    public void FastTravelSigns_Function9MissingEpf3_AnAddActivateChoiceEntryCarryingEpft4EpfbAndEpf2_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = Scan(Record("PERK", 0x050008AB,
            Subrecord("EDID", "FTS_CallMarkerPerk\0"u8.ToArray()),
            Subrecord("PRKE", [2, 0, 0]),
            Subrecord("DATA", [0, 9, 0]),
            Subrecord("EPFT", [4]),
            Subrecord("EPFB", new byte[2]),
            Subrecord("EPF2", new byte[27]),
            Subrecord("PRKF", [])));

        var d = Assert.Single(diagnoses);
        Assert.Equal("entry-point-parameter-shape", d.DefectClass);
        Assert.Equal("PERK 050008AB (FTS_CallMarkerPerk)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("entry point 0 (function 9, Add Activate Choice) is missing EPF3; vanilla always writes it", d.Message);
    }

    [Fact]
    public void Radfall_Function6WithParameters_AnAbsoluteValueEntryCarryingAnEpftEpfbEpfdBlockItNeverTakes_IsDiagnosedLossyByExactClassAndText()
    {
        var diagnoses = Scan(Record("PERK", 0x0004C92C,
            Subrecord("EDID", "Sniper03\0"u8.ToArray()),
            Subrecord("PRKE", [2, 0, 0]),
            Subrecord("DATA", [0, 6, 0]),
            Subrecord("EPFT", [1]),
            Subrecord("EPFB", new byte[2]),
            Subrecord("EPFD", new byte[4]),
            Subrecord("PRKF", [])));

        var d = Assert.Single(diagnoses);
        Assert.Equal("entry-point-parameter-shape", d.DefectClass);
        Assert.Equal("PERK 0004C92C (Sniper03)", d.Anchor);
        var tailCarryingTheByteCostBecauseRepairRemovesTheWholeParameterBlockEpftEpfbEpfdHeadersIncluded = d.Tail;
        Assert.Equal("repairable (drops 25 bytes)", tailCarryingTheByteCostBecauseRepairRemovesTheWholeParameterBlockEpftEpfbEpfdHeadersIncluded);
        Assert.Equal("entry point 0 (function 6, Absolute Value) has EPFT 1; vanilla writes no parameters", d.Message);
    }

    [Fact]
    public void EntryPointShape_AVanillaShapedFunction14_ReportsNothing()
    {
        var record = Record("PERK", 0x00000009,
            Subrecord("EDID", "CleanPerk\0"u8.ToArray()),
            Subrecord("PRKE", [2, 0, 0]),
            Subrecord("DATA", [0, 14, 0]),
            Subrecord("EPFT", [8]),
            Subrecord("EPFD", new byte[8]),
            Subrecord("PRKF", []));

        Assert.Empty(Scan(record));
    }

    [Fact]
    public void EntryPointShape_AFunctionVanillaNeverExercises_MakesNoClaim_Function4NeverOccursInTheShippedGameSoNoCanonicalShapeIsProvableAndTheTableStaysSilentRatherThanTrustingAReferencesComments()
    {
        var record = Record("PERK", 0x0000000A,
            Subrecord("PRKE", [2, 0, 0]),
            Subrecord("DATA", [0, 4, 0]),
            Subrecord("EPFT", [1]),
            Subrecord("EPFD", new byte[4]),
            Subrecord("PRKF", []));

        Assert.Empty(Scan(record));
    }

    private static List<PluginDiagnosis> Scan(byte[] bytes)
    {
        using var folder = new ScratchDirectory("malformed-scan");
        var path = Path.Combine(folder.Path, "scanned.esp");
        File.WriteAllBytes(path, bytes);
        var claim = PluginBinaryHash.ClaimOfFile(path);
        Assert.NotNull(claim);
        Assert.NotNull(claim.Diagnoses);
        return [.. claim.Diagnoses];
    }

    [Fact]
    public void FixedSize_AnExactLengthSubrecord_ReportsNothing()
    {
        var record = Record("REGN", 0x00000001, Subrecord("EDID", "CleanRegion\0"u8.ToArray()), Subrecord("RDAT", new byte[8]));

        Assert.Empty(Scan(record));
    }

    [Fact]
    public void FixedCount_ARaceWithThirtyOneNames_IsDiagnosed()
    {
        var names = Enumerable.Range(0, 31).Select(_ => Subrecord("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000002, [Subrecord("EDID", "ShortRace\0"u8.ToArray()), .. names]);

        var d = Assert.Single(Scan(record));
        Assert.Equal("fixed-count-list-wrong-count", d.DefectClass);
        Assert.Equal("RACE 00000002 (ShortRace)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("NAME appears 31 times; the Creation Kit always writes 32", d.Message);
    }

    [Fact]
    public void FixedCount_ARaceWithAllThirtyTwoNames_ReportsNothing()
    {
        var names = Enumerable.Range(0, 32).Select(_ => Subrecord("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000003, [Subrecord("EDID", "CleanRace\0"u8.ToArray()), .. names]);

        Assert.Empty(Scan(record));
    }

    [Fact]
    public void CounterEntries_AnXwpgDisagreeingWithItsXwpnEntries_IsDiagnosed()
    {
        var record = Record("REFR", 0x00000004,
            Subrecord("EDID", "BadWorkshop\0"u8.ToArray()),
            Subrecord("XWPG", U32(1)),
            Subrecord("XWPN", new byte[12]),
            Subrecord("XWPN", new byte[12]));

        var d = Assert.Single(Scan(record));
        Assert.Equal("counter-entries-mismatch", d.DefectClass);
        Assert.Equal("REFR 00000004 (BadWorkshop)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("XWPG counts 1; 2 XWPN entries follow", d.Message);
    }

    [Fact]
    public void CounterEntries_AnAgreeingPair_ReportsNothing()
    {
        var record = Record("REFR", 0x00000005,
            Subrecord("XWPG", U32(2)), Subrecord("XWPN", new byte[12]), Subrecord("XWPN", new byte[12]));

        Assert.Empty(Scan(record));
    }

    [Fact]
    public void CkOrder_TrailingObtfFullWithNoClosingObts_IsDiagnosed_BecauseTheCkClosesEveryObtfLedCombinationWithAnObts()
    {
        var record = Record("WEAP", 0x00000006,
            Subrecord("EDID", "BadWeap\0"u8.ToArray()),
            Subrecord("OBTE", U32(1)),
            Subrecord("OBTS", new byte[8]),
            Subrecord("OBTF", []), Subrecord("FULL", "N\0"u8.ToArray()),
            Subrecord("STOP", []));

        var d = Assert.Single(Scan(record));
        Assert.Equal("subrecord-out-of-ck-order", d.DefectClass);
        Assert.Equal("WEAP 00000006 (BadWeap)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS", d.Message);
    }

    [Fact]
    public void CkOrder_ALeadingBareObtsFollowedByClosedCombinations_ReportsNothing_BecauseItIsVanillaGaussRiflesShapeTheDefaultCombinationAndCanonicalCkOutputProvenByTheMeditSmokeVanillaScan()
    {
        var record = Record("WEAP", 0x00000007,
            Subrecord("OBTE", U32(2)),
            Subrecord("OBTS", new byte[8]),
            Subrecord("OBTF", []), Subrecord("FULL", "A\0"u8.ToArray()), Subrecord("OBTS", new byte[8]),
            Subrecord("STOP", []));

        Assert.Empty(Scan(record));
    }

    [Fact]
    public void Scan_ACleanRecordOfAnUntabledType_ReportsNothing()
    {
        var record = Record("MISC", 0x00000008, Subrecord("EDID", "Junk\0"u8.ToArray()), Subrecord("DATA", new byte[8]));

        Assert.Empty(Scan(record));
    }

    private static byte[] RaceWithNames(uint formId, string editorId, int nameCount)
    {
        var subs = new List<byte[]> { Subrecord("EDID", Encoding.UTF8.GetBytes(editorId + "\0")) };
        subs.AddRange(Enumerable.Range(0, nameCount).Select(_ => Subrecord("NAME", "Slot\0"u8.ToArray())));
        return Record("RACE", formId, [.. subs]);
    }
}
