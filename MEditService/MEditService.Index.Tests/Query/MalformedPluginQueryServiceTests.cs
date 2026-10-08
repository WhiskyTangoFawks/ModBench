using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class MalformedPluginQueryServiceTests : IDisposable
{
    private const string Malformed = ShortRdatRegionPlugin.FileName;
    private const string ShortRdat = "fixed-size-subrecord-short";

    private readonly ScratchDirectory _instance = new("medit-malformed-query-");

    public void Dispose() => _instance.Dispose();

    private string GameDirectory => Directory.CreateDirectory(Path.Combine(_instance, "GameDir")).FullName;

    private LoadOrderEntry Plugin(
        string name, string origin = "SomeMod", int? slot = 0, bool enabled = true, bool winning = true,
        bool malformed = true)
    {
        var path = Path.Combine(Directory.CreateDirectory(Path.Combine(_instance, "mods", origin)).FullName, name);
        if (malformed) File.WriteAllBytes(path, ShortRdatRegionPlugin.Plugin.Bytes);
        else new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4).WriteToBinary(path);
        return new LoadOrderEntry(name, path, origin, slot, enabled, winning);
    }

    private LoadOrderEntry Clean(string name, int slot = 0) => Plugin(name, slot: slot, malformed: false);

    private PluginDiagnosisReport[] Diagnose(params LoadOrderEntry[] plugins)
    {
        using var index = Indexes.Reconciled(GameDirectory, plugins);
        return [.. index.Malformed.GetLoadOrderDiagnoses()];
    }

    [Fact]
    public void GetLoadOrderDiagnoses_AMalformedHeldPlugin_IsReportedWithTheRefusalWording()
    {
        var report = Assert.Single(Diagnose(Plugin(Malformed)));

        Assert.Equal(Malformed, report.Plugin);
        Assert.Equal("SomeMod", report.Origin);
        Assert.Equal(ShortRdatRegionPlugin.Anchor, report.Anchor);
        Assert.Equal(ShortRdat, report.DefectClass);
        Assert.Equal("repairable (lossless)", report.Tail);
        Assert.Equal("RDAT is 6 bytes; a REGN RDAT is always 8", report.Message);
        Assert.Equal(
            $"{ShortRdatRegionPlugin.Anchor} — fixed-size-subrecord-short, repairable (lossless): "
            + "RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
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

        using var index = Indexes.Reconciled(GameDirectory, [upper, master]);

        Assert.Empty(index.Malformed.GetLoadOrderDiagnoses());
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
    public void GetLoadOrderDiagnoses_APluginThatIsNotActive_IsReported_ForMalformedMeansBytesDepartingFromWhatTheCreationKitWritesActiveOrNot(int? slot, bool enabled)
    {
        var inactive = Plugin(Malformed, slot: slot, enabled: enabled);

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
        index.Reconcile(holder, GameDirectory, [held, gone], GameRelease.Fallout4);
        Assert.Single(index.Malformed.GetLoadOrderDiagnoses());

        index.Reconcile(holder, GameDirectory, [held], GameRelease.Fallout4);

        Assert.Empty(index.Malformed.GetLoadOrderDiagnoses());
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
        var disabled = Plugin("Disabled.esp", origin: "DisabledMod", slot: 0, enabled: false);
        var second = Plugin("Second.esp", origin: "SecondMod", slot: 2);
        var first = Plugin("First.esp", origin: "FirstMod", slot: 1, malformed: false);
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

    [Fact]
    public async Task GetLoadOrderDiagnoses_WhileReconciling_IsNotReady_ForAPluginTheProjectionHasNotReachedHasNoRowsYetAndWouldReadClean()
    {
        LoadOrderEntry[] plugins = [Plugin(Malformed), Clean("Later.esp", slot: 1)];
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, GameDirectory, plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        Assert.Throws<IndexNotReadyException>(index.Malformed.GetLoadOrderDiagnoses);

        gate.Release();
        await load;
        Assert.Single(index.Malformed.GetLoadOrderDiagnoses());
    }

    [Fact]
    public void GetLoadOrderDiagnoses_WithNoLoadOrderHeld_Throws()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(index.Malformed.GetLoadOrderDiagnoses);
    }
}
