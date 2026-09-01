using MEditService.Core.Plugins;
using MEditService.Core.Queries;

namespace MEditService.Tests.Queries;

/// <summary>
/// The session-load half of the Kind B detectors (#570): every held, mutable plugin's binary is
/// scanned from its original bytes, worded exactly as the Track refusal would word it (the same
/// <c>PluginDiagnosis.Describe()</c>, #569 — no separate vocabulary).
/// </summary>
public sealed class MalformedPluginQueryServiceTests
{
    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "TestData", name);

    private static PluginMetadata Plugin(string name, string path, string origin = "SomeMod", bool isForced = false) =>
        new(name, path, LoadOrderIndex: 0, IsLight: false, IsMaster: false, Masters: [],
            RecordCount: 1, IsForced: isForced, Origin: origin, Enabled: true, Winning: true);

    [Fact]
    public void ScanAll_AMalformedHeldPlugin_ReportsTheRefusalWording()
    {
        var reports = MalformedPluginQueryService.ScanAll(
            [Plugin("LitR - TrueStorms.esp", Fixture("LitR - TrueStorms.esp"))], logger: null);

        var r = Assert.Single(reports);
        Assert.Equal("LitR - TrueStorms.esp", r.Plugin);
        Assert.Equal("SomeMod", r.Origin);
        Assert.Equal("fixed-size-subrecord-short", r.DefectClass);
        Assert.Equal("repairable (lossless)", r.Tail);
        // Verbatim the refusal fragment (#569's Describe) — the Problems panel and the Track
        // refusal must never develop separate vocabularies.
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            r.Text);
    }

    [Fact]
    public void ScanAll_AnImmutablePlugin_IsNeverDiagnosed()
    {
        // medit-repair.md: immutable plugins ARE the proof set the tables were built from — a
        // hit there is a table bug (the vanilla-proof test's job), never a user-facing diagnosis.
        var reports = MalformedPluginQueryService.ScanAll(
            [Plugin("LitR - TrueStorms.esp", Fixture("LitR - TrueStorms.esp"), origin: "Data", isForced: true)],
            logger: null);

        Assert.Empty(reports);
    }

    [Fact]
    public void ScanAll_AFileGoneFromDisk_IsSkippedNotThrown()
    {
        // Never assume exclusive ownership (root CLAUDE.md): the file can vanish between the
        // reconcile and this scan. Absence is validation's finding, not this scan's.
        var reports = MalformedPluginQueryService.ScanAll(
            [Plugin("Gone.esp", Fixture("no-such-file.esp"))], logger: null);

        Assert.Empty(reports);
    }

    [Fact]
    public void ScanAll_ACleanPlugin_ReportsNothing()
    {
        var reports = MalformedPluginQueryService.ScanAll(
            [Plugin("RecruitSierra.esl", Fixture("RecruitSierra.esl"))], logger: null);

        Assert.Empty(reports);
    }
}
