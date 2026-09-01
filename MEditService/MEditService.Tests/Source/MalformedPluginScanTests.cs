using System.Buffers.Binary;
using System.Text;
using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// The Kind B per-class detectors (#569): byte-level scans over a plugin's own structure that name
/// a malformed record's defect class from the original bytes alone — no Mutagen, no recompiled
/// counterpart, which is what lets #570 run them at session load. Hand-built bytes pin each
/// detector's contract; the committed real fixtures pin the exact diagnosis one defective record
/// each produces (<c>MalformedFixtureGenerator</c> regenerates the cut-down ones).
/// </summary>
public sealed class MalformedPluginScanTests
{
    // ── R2: fixed-size subrecord short — real fixture (LitR - TrueStorms.esp) ────────────────

    [Fact]
    public void TrueStorms_ShortRegnRdat_IsDiagnosedByExactClassAndText()
    {
        var bytes = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "TestData", "LitR - TrueStorms.esp"));

        var diagnoses = MalformedPluginScan.Scan(bytes);

        var d = Assert.Single(diagnoses, d => d.DefectClass == "fixed-size-subrecord-short");
        Assert.Equal("REGN 001D2AF4 (DowntownRegion)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", d.Message);
    }

    // ── R1/R3/R4: real cut-down fixtures (MalformedFixtureGenerator) ─────────────────────────

    [Fact]
    public void GaussRevolver_TemplateRotation_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = ScanFixture("GaussRevolver - CutDown.esp");

        var d = Assert.Single(diagnoses);
        Assert.Equal("subrecord-out-of-ck-order", d.DefectClass);
        Assert.Equal("WEAP 01000860 (GaussRevolver)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS", d.Message);
    }

    [Fact]
    public void Lunar_BothShortBipedNameLists_AreDiagnosedByExactClassAndText()
    {
        var diagnoses = ScanFixture("Lunar-UniqueCreatures - CutDown.esp");

        Assert.Equal(2, diagnoses.Count);
        Assert.All(diagnoses, d => Assert.Equal("fixed-count-list-wrong-count", d.DefectClass));
        Assert.All(diagnoses, d => Assert.Equal("repairable (lossless)", d.Tail));
        var fogCrawler = Assert.Single(diagnoses, d => d.Anchor == "RACE 03014174 (DLC03_FogCrawlerRace)");
        Assert.Equal("NAME appears 31 times; the Creation Kit always writes 32", fogCrawler.Message);
        var gatorclaw = Assert.Single(diagnoses, d => d.Anchor == "RACE 0603637A (DLC04_GatorclawRace)");
        Assert.Equal("NAME appears 30 times; the Creation Kit always writes 32", gatorclaw.Message);
    }

    [Fact]
    public void SouthOfTheSea_CounterDisagreeingWithEntries_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = ScanFixture("SouthOfTheSea - CutDown.esm");

        var d = Assert.Single(diagnoses);
        Assert.Equal("counter-entries-mismatch", d.DefectClass);
        Assert.Equal("REFR 07431EDC (00sots_Necropolis_WorkshopRef)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("XWPG counts 1; 2 XWPN entries follow", d.Message);
    }

    // ── R5/R6/R7: PERK entry-point parameter shape (real fixtures) ───────────────────────────

    [Fact]
    public void PlasmaAutocannon_WrongEpftForFunction14_IsDiagnosedByExactClassAndText()
    {
        // Already committed whole (SKI_PlasmaAutocannon.esp) — entry 0 of the same PERK is clean,
        // which is what pins the per-entry indexing.
        var diagnoses = ScanFixture("SKI_PlasmaAutocannon.esp");

        var d = Assert.Single(diagnoses, d => d.DefectClass == "entry-point-parameter-shape");
        Assert.Equal("PERK 040000EF (T6M_QuickReload_ReloadVATs)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("entry point 1 (function 14, Multiply 1 + Actor Value Mult) has EPFT 2; vanilla writes EPFT 8", d.Message);
    }

    [Fact]
    public void FastTravelSigns_Function9MissingEpf3_IsDiagnosedByExactClassAndText()
    {
        var diagnoses = ScanFixture("FTS_FastTravelSettlement - CutDown.esp");

        var d = Assert.Single(diagnoses);
        Assert.Equal("entry-point-parameter-shape", d.DefectClass);
        Assert.Equal("PERK 050008AB (FTS_CallMarkerPerk)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("entry point 0 (function 9, Add Activate Choice) is missing EPF3; vanilla always writes it", d.Message);
    }

    [Fact]
    public void Radfall_Function6WithParameters_IsDiagnosedLossyByExactClassAndText()
    {
        var diagnoses = ScanFixture("Radfall - CutDown.esp");

        var d = Assert.Single(diagnoses);
        Assert.Equal("entry-point-parameter-shape", d.DefectClass);
        Assert.Equal("PERK 0004C92C (Sniper03)", d.Anchor);
        // Repair here removes the parameter block the function never takes — EPFT and EPFD,
        // headers included — so the tail carries the byte cost.
        Assert.Equal("repairable (drops 17 bytes)", d.Tail);
        Assert.Equal("entry point 0 (function 6, Absolute Value) has EPFT 1; vanilla writes no parameters", d.Message);
    }

    [Fact]
    public void EntryPointShape_AVanillaShapedFunction14_ReportsNothing()
    {
        var record = Record("PERK", 0x00000009,
            Sub("EDID", "CleanPerk\0"u8.ToArray()),
            Sub("PRKE", [2, 0, 0]),
            Sub("DATA", [0, 14, 0]),
            Sub("EPFT", [8]),
            Sub("EPFD", new byte[8]),
            Sub("PRKF", []));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    [Fact]
    public void EntryPointShape_AFunctionVanillaNeverExercises_MakesNoClaim()
    {
        // fn 4 never occurs in the shipped game, so no canonical shape is provable for it —
        // the table stays silent rather than trusting a reference's comments.
        var record = Record("PERK", 0x0000000A,
            Sub("PRKE", [2, 0, 0]),
            Sub("DATA", [0, 4, 0]),
            Sub("EPFT", [1]),
            Sub("EPFD", new byte[4]),
            Sub("PRKF", []));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    private static List<PluginDiagnosis> ScanFixture(string fileName) =>
        MalformedPluginScan.Scan(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "TestData", fileName)));

    // ── Per-detector contracts on hand-built bytes ───────────────────────────────────────────

    [Fact]
    public void FixedSize_AnExactLengthSubrecord_ReportsNothing()
    {
        var record = Record("REGN", 0x00000001, Sub("EDID", "CleanRegion\0"u8.ToArray()), Sub("RDAT", new byte[8]));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    [Fact]
    public void FixedCount_ARaceWithThirtyOneNames_IsDiagnosed()
    {
        var names = Enumerable.Range(0, 31).Select(_ => Sub("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000002, [Sub("EDID", "ShortRace\0"u8.ToArray()), .. names]);

        var d = Assert.Single(MalformedPluginScan.Scan(record));
        Assert.Equal("fixed-count-list-wrong-count", d.DefectClass);
        Assert.Equal("RACE 00000002 (ShortRace)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("NAME appears 31 times; the Creation Kit always writes 32", d.Message);
    }

    [Fact]
    public void FixedCount_ARaceWithAllThirtyTwoNames_ReportsNothing()
    {
        var names = Enumerable.Range(0, 32).Select(_ => Sub("NAME", "Slot\0"u8.ToArray())).ToArray();
        var record = Record("RACE", 0x00000003, [Sub("EDID", "CleanRace\0"u8.ToArray()), .. names]);

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    [Fact]
    public void CounterEntries_AnXwpgDisagreeingWithItsXwpnEntries_IsDiagnosed()
    {
        var record = Record("REFR", 0x00000004,
            Sub("EDID", "BadWorkshop\0"u8.ToArray()),
            Sub("XWPG", Le(1)),
            Sub("XWPN", new byte[12]),
            Sub("XWPN", new byte[12]));

        var d = Assert.Single(MalformedPluginScan.Scan(record));
        Assert.Equal("counter-entries-mismatch", d.DefectClass);
        Assert.Equal("REFR 00000004 (BadWorkshop)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("XWPG counts 1; 2 XWPN entries follow", d.Message);
    }

    [Fact]
    public void CounterEntries_AnAgreeingPair_ReportsNothing()
    {
        var record = Record("REFR", 0x00000005,
            Sub("XWPG", Le(2)), Sub("XWPN", new byte[12]), Sub("XWPN", new byte[12]));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    [Fact]
    public void CkOrder_AnObtsPrecedingItsObtfAndFull_IsDiagnosed()
    {
        // GaussRevolver.esp's real shape: every OBTS sits one combination early —
        // OBTE, OBTS, [OBTF FULL OBTS] … — where the CK writes OBTF, FULL, OBTS per combination.
        var record = Record("WEAP", 0x00000006,
            Sub("EDID", "BadWeap\0"u8.ToArray()),
            Sub("OBTE", Le(2)),
            Sub("OBTS", new byte[8]),
            Sub("OBTF", []), Sub("FULL", "N\0"u8.ToArray()), Sub("OBTS", new byte[8]),
            Sub("STOP", []));

        var d = Assert.Single(MalformedPluginScan.Scan(record));
        Assert.Equal("subrecord-out-of-ck-order", d.DefectClass);
        Assert.Equal("WEAP 00000006 (BadWeap)", d.Anchor);
        Assert.Equal("repairable (lossless)", d.Tail);
        Assert.Equal("template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS", d.Message);
    }

    [Fact]
    public void CkOrder_ATemplateInCkOrder_ReportsNothing()
    {
        var record = Record("WEAP", 0x00000007,
            Sub("OBTE", Le(2)),
            Sub("OBTF", []), Sub("FULL", "A\0"u8.ToArray()), Sub("OBTS", new byte[8]),
            Sub("OBTS", new byte[8]), // a bare combination *after* dressed ones is not the rotation
            Sub("STOP", []));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    [Fact]
    public void Scan_ACleanRecordOfAnUntabledType_ReportsNothing()
    {
        var record = Record("MISC", 0x00000008, Sub("EDID", "Junk\0"u8.ToArray()), Sub("DATA", new byte[8]));

        Assert.Empty(MalformedPluginScan.Scan(record));
    }

    // ── byte builders (same conventions as PluginBinaryWalkTests) ────────────────────────────

    private static byte[] Le(uint value)
    {
        var b = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(b, value);
        return b;
    }

    private static byte[] Sub(string sig, byte[] payload)
    {
        var b = new byte[6 + payload.Length];
        Encoding.ASCII.GetBytes(sig).CopyTo(b, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(4), (ushort)payload.Length);
        payload.CopyTo(b, 6);
        return b;
    }

    private static byte[] Record(string type, uint formId, params byte[][] subrecords)
    {
        var data = subrecords.SelectMany(s => s).ToArray();
        var b = new byte[24 + data.Length];
        Encoding.ASCII.GetBytes(type).CopyTo(b, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), (uint)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(8), 0); // flags: uncompressed
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(12), formId);
        data.CopyTo(b, 24);
        return b;
    }
}
