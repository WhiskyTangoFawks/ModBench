using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class PluginDiagnosisRowTests : IDisposable
{
    private const string MalformedFixture = ShortRdatRegionPlugin.FileName;
    private const string Origin = "ShortRdatMod";
    private static readonly PluginAddress Key = new(MalformedFixture, Origin);

    private readonly ScratchDirectory _gameDirectory = new("medit-diagnosis-game-");
    private readonly ScratchDirectory _instanceRoot = new("medit-diagnosis-instance-");
    private readonly string _pluginPath;

    public PluginDiagnosisRowTests()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, MalformedFixture);
        ShortRdatRegionPlugin.Plugin.WriteInto(modFolder);
    }

    public void Dispose()
    {
        _gameDirectory.Dispose();
        _instanceRoot.Dispose();
    }

    private LoadOrderEntry Entry => new(MalformedFixture, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private OpenedIndex Reconciled(LoadOrderHolder holder, GatedPluginAdapter? opens = null)
    {
        var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        return index;
    }

    private void RepairOnDiskAsAnotherToolWouldWithTheSameNameAndCleanBytes()
    {
        var clean = new Fallout4Mod(ModKey.FromFileName(MalformedFixture), Fallout4Release.Fallout4);
        clean.Npcs.AddNew("RepairedNpc");
        clean.WriteToBinary(_pluginPath);
    }

    [Fact]
    public void AMalformedPluginThatIsNotActive_StillReadsAsItsDiagnosisRows()
    {
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, _gameDirectory, [Entry with { Enabled = false }], GameRelease.Fallout4, _instanceRoot);

        var report = Assert.Single(index.Malformed.GetLoadOrderDiagnoses().Value());
        Assert.Equal(Key, new PluginAddress(report.Plugin, report.Origin));
    }

    [Fact]
    public void AMalformedPlugin_ReadsAsDiagnosisRows_WordedAsTheScanWordsThem()
    {
        using var index = Reconciled(new LoadOrderHolder());

        var report = Assert.Single(index.Malformed.GetLoadOrderDiagnoses().Value());

        Assert.Equal(Key, new PluginAddress(report.Plugin, report.Origin));
        Assert.Equal("fixed-size-subrecord-short", report.DefectClass);
        Assert.Equal(ShortRdatRegionPlugin.Anchor, report.Anchor);
        Assert.Equal("repairable (lossless)", report.Tail);
        Assert.Equal(
            $"{ShortRdatRegionPlugin.Anchor} — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            report.Text);
    }

    [Fact]
    public async Task ARepairedBinary_ReDerived_HasNoDiagnosisRow()
    {
        using var index = Reconciled(new LoadOrderHolder());
        Assert.Single(index.Malformed.GetLoadOrderDiagnoses().Value());

        RepairOnDiskAsAnotherToolWouldWithTheSameNameAndCleanBytes();
        index.NextSnapshot();

        Assert.Empty(index.Malformed.GetLoadOrderDiagnoses().Value());
    }

    [Fact]
    public void ADiagnosisRow_PersistsAcrossLaunches_AndIsReDerivedWhenTheBinaryChangedUnderneath()
    {
        using (Reconciled(new LoadOrderHolder())) { }

        using var opens = new GatedPluginAdapter();
        using (var warm = Reconciled(new LoadOrderHolder(), opens))
        {
            Assert.Equal(0, opens.OpenedTotal);
            Assert.Single(warm.Malformed.GetLoadOrderDiagnoses().Value());
        }

        RepairOnDiskAsAnotherToolWouldWithTheSameNameAndCleanBytes();
        using var reopened = Reconciled(new LoadOrderHolder());
        Assert.Empty(reopened.Malformed.GetLoadOrderDiagnoses().Value());
    }

    [Fact]
    public void ADiagnosisRow_OfAPluginTheSnapshotStoppedNaming_AnswersNothing()
    {
        var holder = new LoadOrderHolder();
        using var index = Reconciled(holder);
        Assert.Single(index.Malformed.GetLoadOrderDiagnoses().Value());

        index.Reconcile(holder, _gameDirectory, [], GameRelease.Fallout4, _instanceRoot);

        Assert.Empty(index.Malformed.GetLoadOrderDiagnoses().Value());
    }
}
