using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class PluginDiagnosisRowTests : IDisposable
{
    private const string MalformedFixture = "LitR - TrueStorms.esp";
    private const string Origin = "TrueStormsMod";
    private static readonly PluginAddress Key = new(MalformedFixture, Origin);

    private readonly ScratchDirectory _gameDirectory = new("medit-diagnosis-game-");
    private readonly ScratchDirectory _instanceRoot = new("medit-diagnosis-instance-");
    private readonly string _pluginPath;

    public PluginDiagnosisRowTests()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, MalformedFixture);
        File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", MalformedFixture), _pluginPath);
    }

    public void Dispose()
    {
        _gameDirectory.Dispose();
        _instanceRoot.Dispose();
    }

    private LoadOrderEntry Entry => new(MalformedFixture, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private Indexer Reconciled(LoadOrderHolder holder, GatedPluginAdapter? opens = null)
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

        Assert.Equal(Key, Assert.Single(index.RequireReads().GetPluginDiagnoses()).Plugin);
    }

    [Fact]
    public void AMalformedPlugin_ReadsAsDiagnosisRows_WordedAsTheScanWordsThem()
    {
        using var index = Reconciled(new LoadOrderHolder());

        var row = Assert.Single(index.RequireReads().GetPluginDiagnoses());

        Assert.Equal(Key, row.Plugin);
        Assert.Equal("fixed-size-subrecord-short", row.Diagnosis.DefectClass);
        Assert.Equal("REGN 001D2AF4 (DowntownRegion)", row.Diagnosis.Anchor);
        Assert.Equal("repairable (lossless)", row.Diagnosis.Tail);
        Assert.Equal(
            "REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            row.Diagnosis.Describe());
    }

    [Fact]
    public async Task ARepairedBinary_ReDerived_HasNoDiagnosisRow()
    {
        using var index = Reconciled(new LoadOrderHolder());
        Assert.Single(index.RequireReads().GetPluginDiagnoses());

        RepairOnDiskAsAnotherToolWouldWithTheSameNameAndCleanBytes();
        Assert.True(index.Revalidate());

        Assert.Empty(index.RequireReads().GetPluginDiagnoses());
    }

    [Fact]
    public void ADiagnosisRow_PersistsAcrossLaunches_AndIsReDerivedWhenTheBinaryChangedUnderneath()
    {
        using (Reconciled(new LoadOrderHolder())) { }

        using var opens = new GatedPluginAdapter();
        using (var warm = Reconciled(new LoadOrderHolder(), opens))
        {
            Assert.Equal(0, opens.OpenedTotal);
            Assert.Single(warm.RequireReads().GetPluginDiagnoses());
        }

        RepairOnDiskAsAnotherToolWouldWithTheSameNameAndCleanBytes();
        using var reopened = Reconciled(new LoadOrderHolder());
        Assert.Empty(reopened.RequireReads().GetPluginDiagnoses());
    }

    [Fact]
    public void ADiagnosisRow_OfAPluginTheSnapshotStoppedNaming_AnswersNothing()
    {
        var holder = new LoadOrderHolder();
        using var index = Reconciled(holder);
        Assert.Single(index.RequireReads().GetPluginDiagnoses());

        index.Reconcile(holder, _gameDirectory, [], GameRelease.Fallout4, _instanceRoot);

        Assert.Empty(index.RequireReads().GetPluginDiagnoses());
    }
}
