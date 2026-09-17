using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Queries;

/// <summary>Session-load scans are worded exactly as the Track refusal would word them (the same
/// <c>PluginDiagnosis.Describe()</c>, no separate vocabulary).</summary>
public sealed class MalformedPluginQueryServiceTests
{
    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "TestData", name);

    private static RegisteredCopy Plugin(string name, string path, string origin = "SomeMod", bool isForced = false) =>
        new(name, origin, path, Slot: 0, Enabled: true, Winning: true, IsForced: isForced);

    private static IReadOnlyList<PluginDiagnosisReport> Diagnose(params RegisteredCopy[] copies) =>
        new MalformedPluginQueryService(FakeLoadOrder.Of(GameRelease.Fallout4, copies)).GetLoadOrderDiagnoses();

    [Fact]
    public void GetLoadOrderDiagnoses_AMalformedHeldPlugin_ReportsTheRefusalWording()
    {
        var reports = Diagnose(Plugin("LitR - TrueStorms.esp", Fixture("LitR - TrueStorms.esp")));

        var r = Assert.Single(reports);
        Assert.Equal("LitR - TrueStorms.esp", r.Plugin);
        Assert.Equal("SomeMod", r.Origin);
        Assert.Equal("fixed-size-subrecord-short", r.DefectClass);
        Assert.Equal("repairable (lossless)", r.Tail);
        // Verbatim PluginDiagnosis.Describe()'s refusal fragment — the Problems panel and the Track
        // refusal must never develop separate vocabularies.
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            r.Text);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AnImmutablePlugin_IsNeverDiagnosed()
    {
        // medit-repair.md: immutable plugins ARE the proof set the tables were built from — a
        // hit there is a table bug (the vanilla-proof test's job), never a user-facing diagnosis.
        var reports = Diagnose(
            Plugin("LitR - TrueStorms.esp", Fixture("LitR - TrueStorms.esp"), origin: "Data", isForced: true));

        Assert.Empty(reports);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AFileGoneFromDisk_IsSkippedNotThrown()
    {
        // Never assume exclusive ownership (root CLAUDE.md): the file can vanish between the
        // reconcile and this scan. Absence is validation's finding, not this scan's.
        var reports = Diagnose(Plugin("Gone.esp", Fixture("no-such-file.esp")));

        Assert.Empty(reports);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_ACleanPlugin_ReportsNothing()
    {
        var reports = Diagnose(Plugin("RecruitSierra.esl", Fixture("RecruitSierra.esl")));

        Assert.Empty(reports);
    }
}
