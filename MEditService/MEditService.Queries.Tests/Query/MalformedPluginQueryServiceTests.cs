using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

/// <summary>A diagnosis is a row the Index projected when it hashed the binary; this service joins
/// those rows to the load order, which says which plugins an edit can reach and in what order they
/// are read.</summary>
public sealed class MalformedPluginQueryServiceTests
{
    private const string Malformed = "LitR - TrueStorms.esp";

    private static readonly PluginDiagnosis Short = new(
        "REGN 001D2AF4 (DowntownRegion)", "fixed-size-subrecord-short", "repairable (lossless)",
        "RDAT is 6 bytes; a REGN RDAT is always 8");

    private static readonly PluginDiagnosis Trailing = new(
        "NPC_ 00012345 (Sierra)", "trailing-bytes", "repairable (lossless)", "3 bytes past the last subrecord");

    private static LoadOrderEntry Plugin(
        string name, string origin = "SomeMod", int? slot = 0, bool enabled = true, bool winning = true) =>
        new(name, $@"C:\mods\{origin}\{name}", origin, slot, enabled, winning);

    private static PluginDiagnosisRow Row(LoadOrderEntry plugin, PluginDiagnosis diagnosis) => new(plugin.Key, diagnosis);

    private static PluginDiagnosisReport[] Diagnose(
        IReadOnlyList<PluginDiagnosisRow> rows, params LoadOrderEntry[] plugins) =>
        [.. new MalformedPluginQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), []) { Diagnoses = rows }),
            FakeLoadOrder.Of(GameRelease.Fallout4, plugins))
            .GetLoadOrderDiagnoses()];

    [Fact]
    public void GetLoadOrderDiagnoses_ARowAgainstAHeldPlugin_IsReportedWithTheRefusalWording()
    {
        var plugin = Plugin(Malformed);

        var report = Assert.Single(Diagnose([Row(plugin, Short)], plugin));

        Assert.Equal(Malformed, report.Plugin);
        Assert.Equal("SomeMod", report.Origin);
        Assert.Equal("REGN 001D2AF4 (DowntownRegion)", report.Anchor);
        Assert.Equal("fixed-size-subrecord-short", report.DefectClass);
        Assert.Equal("repairable (lossless)", report.Tail);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", report.Message);
        // Verbatim PluginDiagnosis.Describe(): the Problems panel and the Track refusal must never
        // develop separate vocabularies.
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): "
            + "RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
    }

    // The plugins loaded with no line are the proof set the tables were built from, so a hit there is
    // a table bug. The Index stamps every plugin it hashes, so the load order drops these.
    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAPluginLoadedWithNoLine_AreNeverReported()
    {
        var master = Plugin("Fallout4.esm", origin: "CleanedMasters") with { LoadedWithNoLine = true };

        Assert.Empty(Diagnose([Row(master, Short)], master));
    }

    // ADR-0012 invariant 1: a filename compares ignoring case, so a second file whose name differs
    // only in case, as a case-sensitive filesystem holds one, is the same plugin loaded with no line.
    [Fact]
    public void GetLoadOrderDiagnoses_APluginLoadedWithNoLine_IsMatchedIgnoringCase()
    {
        var upper = Plugin("FALLOUT4.ESM", origin: "CleanedMasters", enabled: false);
        var master = Plugin("Fallout4.esm", origin: "CleanedMasters") with { LoadedWithNoLine = true };

        Assert.Empty(Diagnose([Row(upper, Short), Row(master, Trailing)], upper, master));
    }

    // Where the file sits decides nothing: a user's plugin placed in the game folder is the user's.
    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAUserPluginInTheGameFolder_AreReported()
    {
        var placed = Plugin(Malformed, origin: PluginOrigin.DataDirectory);

        Assert.Equal(PluginOrigin.DataDirectory, Assert.Single(Diagnose([Row(placed, Short)], placed)).Origin);
    }

    // plugins.md, A row: a malformed plugin is one whose bytes depart from what the Creation Kit
    // writes, active or not.
    [Theory]
    [InlineData(null, true)]
    [InlineData(0, false)]
    public void GetLoadOrderDiagnoses_RowsOfAPluginThatIsNotActive_AreReported(int? slot, bool enabled)
    {
        var inactive = Plugin(Malformed, slot: slot, enabled: enabled);

        Assert.Equal("SomeMod", Assert.Single(Diagnose([Row(inactive, Short)], inactive)).Origin);
    }

    // A plugin the Index never opened stamps no rows, and neither does a clean one; a plugin that
    // failed to load says so through LoadOrderStatus.Failures.
    [Fact]
    public void GetLoadOrderDiagnoses_APluginWithNoRows_IsNotReported()
    {
        Assert.Empty(Diagnose([], Plugin("Clean.esp")));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_ARowNamingAPluginTheLoadOrderDoesNotHold_IsNotReported()
    {
        var held = Plugin("Held.esp");
        var gone = Plugin(Malformed, origin: "RemovedMod");

        Assert.Empty(Diagnose([Row(gone, Short)], held));
    }

    // ADR-0012 invariant 1: a filename is not an identity — origin tells two plugins of one apart.
    [Fact]
    public void GetLoadOrderDiagnoses_TwoPluginsOfOneName_ReportAgainstTheirOwnOrigins()
    {
        var winner = Plugin(Malformed, origin: "WinningMod");
        var overridden = Plugin(Malformed, origin: "LosingMod", winning: false);

        var reports = Diagnose([Row(overridden, Short)], winner, overridden);

        Assert.Equal("LosingMod", Assert.Single(reports).Origin);
    }

    // The load order is the order, a plugin that is not active after every active one, and within
    // one plugin the rows keep the order the binary proved them in.
    [Fact]
    public void GetLoadOrderDiagnoses_AreOrderedByTheLoadOrderThenByRecordOrder()
    {
        var disabled = Plugin("Disabled.esp", origin: "DisabledMod", slot: 0, enabled: false);
        var second = Plugin("Second.esp", origin: "SecondMod", slot: 2);
        var first = Plugin("First.esp", origin: "FirstMod", slot: 1);

        var reports = Diagnose(
            [Row(disabled, Short), Row(second, Short), Row(first, Short), Row(first, Trailing)], disabled, second, first);

        Assert.Equal(
            [("First.esp", "fixed-size-subrecord-short"), ("First.esp", "trailing-bytes"),
             ("Second.esp", "fixed-size-subrecord-short"), ("Disabled.esp", "fixed-size-subrecord-short")],
            reports.Select(r => (r.Plugin, r.DefectClass)));
    }

    // MEditService/CLAUDE.md: a whole-plugin-set derivation gates on Status, because a plugin the
    // projection has not reached has no rows yet and would read clean. GetPlugins answers its own
    // whole-set fact the same way while reconciling.
    [Fact]
    public void GetLoadOrderDiagnoses_WhileReconciling_AnswersNothing()
    {
        var plugin = Plugin(Malformed);
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), []) { Diagnoses = [Row(plugin, Short)] };
        var reconciling = new LoadOrderStatus(
            LoadOrderState.Reconciling, TotalPlugins: 1, ActivePlugins: 1, [], ConflictsComputed: false, []);

        var reports = new MalformedPluginQueryService(
            new FakeIndex(reads, reconciling), FakeLoadOrder.Of(GameRelease.Fallout4, plugin))
            .GetLoadOrderDiagnoses();

        Assert.Empty(reports);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_WithNoLoadOrderHeld_Throws()
    {
        var service = new MalformedPluginQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])),
            new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(service.GetLoadOrderDiagnoses);
    }
}
