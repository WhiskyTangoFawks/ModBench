using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

// The malformed-plugin diagnosis is a row: projected in the pass that hashes the binary, read
// through the reads, validated by that hash, re-derived with the plugin and gone with its rows.
public sealed class PluginDiagnosisRowTests : IDisposable
{
    private const string MalformedFixture = "LitR - TrueStorms.esp";
    private const string Origin = "TrueStormsMod";
    private static readonly PluginAddress Key = new(MalformedFixture, Origin);

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-diagnosis-game-").FullName;
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-diagnosis-instance-").FullName;
    private readonly string _pluginPath;

    public PluginDiagnosisRowTests()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, MalformedFixture);
        File.Copy(Path.Combine(AppContext.BaseDirectory, "TestData", MalformedFixture), _pluginPath);
    }

    public void Dispose()
    {
        Directory.Delete(_gameDirectory, recursive: true);
        Directory.Delete(_instanceRoot, recursive: true);
    }

    private LoadOrderEntry Entry => new(MalformedFixture, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private Indexer Reconciled(LoadOrderHolder holder, GatedPluginAdapter? opens = null)
    {
        var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        return index;
    }

    // Repaired by another tool: the same name, clean bytes.
    private void RepairOnDisk()
    {
        var clean = new Fallout4Mod(ModKey.FromFileName(MalformedFixture), Fallout4Release.Fallout4);
        clean.Npcs.AddNew("RepairedNpc");
        clean.WriteToBinary(_pluginPath);
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

        RepairOnDisk();
        Assert.True(await index.RefreshBinary(Key, _pluginPath));

        Assert.Empty(index.RequireReads().GetPluginDiagnoses());
    }

    // Validated by hash like every row: kept across launches while the bytes match, re-derived
    // at open once they do not.
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

        RepairOnDisk();
        using var reopened = Reconciled(new LoadOrderHolder());
        Assert.Empty(reopened.RequireReads().GetPluginDiagnoses());
    }

    // Registered answers, unregistered answers nothing (ADR-0009 invariant 1): the row is scoped
    // like every other.
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
