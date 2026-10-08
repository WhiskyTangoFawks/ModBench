using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

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
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): "
            + "RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAPluginLoadedWithNoLine_AreNeverReported_ForThoseAreTheProofSetTheTablesWereBuiltFrom()
    {
        var master = Plugin("Fallout4.esm", origin: "CleanedMasters") with { LoadedWithNoLine = true };

        Assert.Empty(Diagnose([Row(master, Short)], master));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_APluginLoadedWithNoLine_IsMatchedIgnoringCase_ForACaseSensitiveFilesystemCanHoldASecondFileDifferingOnlyInCase()
    {
        var upper = Plugin("FALLOUT4.ESM", origin: "CleanedMasters", enabled: false);
        var master = Plugin("Fallout4.esm", origin: "CleanedMasters") with { LoadedWithNoLine = true };

        Assert.Empty(Diagnose([Row(upper, Short), Row(master, Trailing)], upper, master));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_RowsOfAUserPluginInTheGameFolder_AreReported_ForWhereTheFileSitsDecidesNothing()
    {
        var placed = Plugin(Malformed, origin: PluginOrigin.DataDirectory);

        Assert.Equal(PluginOrigin.DataDirectory, Assert.Single(Diagnose([Row(placed, Short)], placed)).Origin);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(0, false)]
    public void GetLoadOrderDiagnoses_RowsOfAPluginThatIsNotActive_AreReported_ForMalformedMeansBytesDepartingFromWhatTheCreationKitWritesActiveOrNot(int? slot, bool enabled)
    {
        var inactive = Plugin(Malformed, slot: slot, enabled: enabled);

        Assert.Equal("SomeMod", Assert.Single(Diagnose([Row(inactive, Short)], inactive)).Origin);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_APluginWithNoRows_IsNotReported_ForTheIndexStampsNoRowsOnANeverOpenedOrCleanPlugin()
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

    [Fact]
    public void GetLoadOrderDiagnoses_TwoPluginsOfOneName_ReportAgainstTheirOwnOrigins_ForAFilenameIsNotAnIdentity()
    {
        var winner = Plugin(Malformed, origin: "WinningMod");
        var overridden = Plugin(Malformed, origin: "LosingMod", winning: false);

        var reports = Diagnose([Row(overridden, Short)], winner, overridden);

        Assert.Equal("LosingMod", Assert.Single(reports).Origin);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AreOrderedByTheLoadOrder_InactiveAfterEveryActiveOne_ThenByTheRecordOrderTheBinaryProvedThem()
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

    [Fact]
    public void GetLoadOrderDiagnoses_WhileReconciling_AnswersNothing_ForAPluginTheProjectionHasNotReachedHasNoRowsYetAndWouldReadClean()
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
