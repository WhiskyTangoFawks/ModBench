using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class LoadOrderDiagnosesTests : IDisposable
{
    private const string Malformed = ShortRdatRegionPlugin.FileName;

    private readonly ScratchDirectory _instance = new("medit-malformed-query-");

    public void Dispose() => _instance.Dispose();

    private string DataFolder => Directory.CreateDirectory(Path.Combine(_instance, "Data")).FullName;

    private LoadOrderEntry Plugin(
        string name, string origin = "SomeMod", int? line = 0, bool enabled = true, bool winning = true,
        bool malformed = true)
    {
        var path = Path.Combine(Directory.CreateDirectory(Path.Combine(_instance, "mods", origin)).FullName, name);
        if (malformed) File.WriteAllBytes(path, ShortRdatRegionPlugin.Plugin.Bytes);
        else new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4).WriteToBinary(path);
        return new LoadOrderEntry(name, path, origin, line, enabled, winning);
    }

    private LoadOrderEntry Clean(string name) => Plugin(name, malformed: false);

    private PluginDiagnosisReport[] Diagnose(params LoadOrderEntry[] plugins)
    {
        using var index = Indexes.Reconciled(DataFolder, plugins);
        return [.. index.Queries.GetLoadOrderDiagnoses().Value()];
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AMalformedHeldPlugin_IsReportedWithTheRefusalWording()
    {
        var report = Assert.Single(Diagnose(Plugin(Malformed)));

        Assert.Equal(Malformed, report.Plugin);
        Assert.Equal("SomeMod", report.Origin);
        Assert.Equal(ShortRdatRegionPlugin.Anchor, report.Anchor);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", report.Message);
        Assert.Equal(
            $"{ShortRdatRegionPlugin.Anchor} — fixed-size-subrecord-short, repairable (lossless): "
            + "RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_ADiagnosisWithNoAnchor_ReadsBackWithNone()
    {
        var adapter = new DiagnosisClaimingAdapter(new PluginDiagnosis(null, "unknown", null, "boom"));
        using var index = Indexes.Reconciled(DataFolder, [Clean("Clean.esp")], adapter: adapter);

        var report = Assert.Single(index.Queries.GetLoadOrderDiagnoses().Value());

        Assert.Equal((null, "boom"), (report.Anchor, report.Message));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_APluginLoadedWithNoLine_IsNeverReported_ForThoseAreTheProofSetTheTablesWereBuiltFrom()
    {
        var loadedWithNoLine = Plugin(Malformed, origin: "CleanedMasters") with { LoadedWithNoLine = true };

        Assert.Empty(Diagnose(loadedWithNoLine));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_APluginLoadedWithNoLine_IsMatchedIgnoringCase_ForACaseSensitiveFilesystemCanHoldASecondFileDifferingOnlyInCase()
    {
        var master = Plugin(Malformed, origin: "CleanedMasters") with { LoadedWithNoLine = true };
        var upper = master with { Name = Malformed.ToUpperInvariant(), LoadedWithNoLine = false, Enabled = false };

        using var index = Indexes.Reconciled(DataFolder, [upper, master]);

        Assert.Empty(index.Queries.GetLoadOrderDiagnoses().Value());
        Assert.Equal([Malformed.ToUpperInvariant(), Malformed], index.Status.Failures.Select(f => f.Name).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AUserPluginInTheGameFolder_IsReported_ForWhereTheFileSitsDecidesNothing()
    {
        var placed = Plugin(Malformed, origin: PluginOrigin.DataDirectory);

        Assert.Equal(PluginOrigin.DataDirectory, Assert.Single(Diagnose(placed)).Origin);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(0, false)]
    public void GetLoadOrderDiagnoses_APluginThatIsNotActive_IsReported_ForMalformedMeansBytesDepartingFromWhatTheCreationKitWritesActiveOrNot(int? line, bool enabled)
    {
        var inactive = Plugin(Malformed, line: line, enabled: enabled);

        Assert.Equal("SomeMod", Assert.Single(Diagnose(inactive)).Origin);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_ACleanPlugin_IsNotReported()
    {
        Assert.Empty(Diagnose(Clean("Clean.esp")));
    }

    [Fact]
    public void GetLoadOrderDiagnoses_APluginTheLoadOrderNoLongerHolds_IsNotReported()
    {
        var held = Clean("Held.esp");
        var gone = Plugin(Malformed, origin: "RemovedMod");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, DataFolder, [held, gone], GameRelease.Fallout4);
        Assert.Single(index.Queries.GetLoadOrderDiagnoses().Value());

        index.Reconcile(holder, DataFolder, [held], GameRelease.Fallout4);

        Assert.Empty(index.Queries.GetLoadOrderDiagnoses().Value());
    }

    [Fact]
    public void GetLoadOrderDiagnoses_TwoPluginsOfOneName_ReportAgainstTheirOwnOrigins_ForAFilenameIsNotAnIdentity()
    {
        var winner = Plugin(Malformed, origin: "WinningMod", malformed: false);
        var overridden = Plugin(Malformed, origin: "LosingMod", winning: false);

        Assert.Equal("LosingMod", Assert.Single(Diagnose(winner, overridden)).Origin);
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AreOrderedByTheLoadOrder_InactiveAfterEveryActiveOne_ThenByTheRecordOrderTheBinaryProvedThem()
    {
        var disabled = Plugin("Disabled.esp", origin: "DisabledMod", line: 0, enabled: false);
        var second = Plugin("Second.esp", origin: "SecondMod", line: 2);
        var first = Plugin("First.esp", origin: "FirstMod", line: 1, malformed: false);
        var mod = new Fallout4Mod(ModKey.FromFileName(first.Name), Fallout4Release.Fallout4);
        MisshapedPerks.Add(mod, "FirstPerk");
        MisshapedPerks.Add(mod, "SecondPerk");
        mod.WriteToBinary(first.Path);
        MisshapedPerks.Misshape(first.Path);

        var reports = Diagnose(disabled, second, first);

        Assert.Equal(
            [("First.esp", "PERK 00000800 (FirstPerk)"), ("First.esp", "PERK 00000801 (SecondPerk)"),
             ("Second.esp", ShortRdatRegionPlugin.Anchor), ("Disabled.esp", ShortRdatRegionPlugin.Anchor)],
            reports.Select(r => (r.Plugin, r.Anchor)));
    }

}
