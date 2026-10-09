using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class PluginSourceUnreadableTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly string _npc;

    public PluginSourceUnreadableTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("plugin-source-unreadable")
            .WithPlugin(PluginName, mod => npc = mod.Npcs.AddNew(NpcEditorId).FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        _npc = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    private PluginAddress Plugin => _entry.KeyOf();

    private string SourceRoot => PluginSourceRoot.In(_entry.ModFolderOf(), PluginName);

    private string Relative(string path) => Path.GetRelativePath(_entry.ModFolderOf(), path);

    private string NpcDocument => Directory.EnumerateFiles(SourceRoot, "*.json", SearchOption.AllDirectories)
        .Single(file => File.ReadAllText(file).Contains($"\"{_npc}\"", StringComparison.Ordinal));

    private string BackupOfTheNpcDocumentClaimingItsFormKeyAgain()
    {
        var document = NpcDocument;
        var folder = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName;
        var backup = Path.Combine(folder, Path.GetFileName(document));
        File.Copy(document, backup);
        return backup;
    }

    private OpenedIndex Reconciled() => Indexes.Reconciled(_fixture, _fixture.InstanceRoot);

    [Fact]
    public void APluginInATrackedModWithNoPluginSource_ReadsItsPluginFile_MarkedAsSuch()
    {
        Directory.Delete(SourceRoot, recursive: true);

        using var index = Reconciled();

        Assert.Equal(NpcEditorId, index.DocumentOf(_npc, Plugin).EditorId);
        Assert.True(index.ReadFromItsPluginFileForItsUnreadableSource(Plugin));
        Assert.Empty(index.Status.Failures);
    }

    [Fact]
    public void APluginWithNoPluginSource_SaysItHoldsNoFolderForIt()
    {
        Directory.Delete(SourceRoot, recursive: true);

        using var index = Reconciled();

        var unreadable = index.PluginRowOf(Plugin)?.PluginSourceUnreadable.Require();
        Assert.Contains(PluginName, unreadable?.Reason, StringComparison.Ordinal);
        Assert.True(unreadable?.DecompileRepairs);
    }

    [PosixFact]
    public void APluginSourceWithTwinFoldersNeitherSpelledAsTheLoadOrderNamesIt_NamesBothFolders()
    {
        var sources = Path.GetDirectoryName(SourceRoot).Require();
        Directory.Move(SourceRoot, Path.Combine(sources, PluginName.ToUpperInvariant()));
        Directory.CreateDirectory(Path.Combine(sources, PluginName.ToLowerInvariant()));

        using var index = Reconciled();

        var unreadable = index.PluginRowOf(Plugin)?.PluginSourceUnreadable.Require();
        Assert.Contains(PluginName.ToUpperInvariant(), unreadable?.Reason, StringComparison.Ordinal);
        Assert.Contains(PluginName.ToLowerInvariant(), unreadable?.Reason, StringComparison.Ordinal);
        Assert.False(unreadable?.DecompileRepairs);
    }

    [Fact]
    public void APluginSourceThatFailsItsRead_SaysWhichFileStoppedIt()
    {
        var backup = BackupOfTheNpcDocumentClaimingItsFormKeyAgain();

        using var index = Reconciled();

        Assert.Contains(Path.GetFileName(backup), index.PluginRowOf(Plugin)?.PluginSourceUnreadable?.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ACopyInAPluginThatIsNotActiveAndWhoseSourceIsUnreadable_IsRenderedFromItsPluginFile()
    {
        Directory.Delete(SourceRoot, recursive: true);
        using var index = Indexes.Reconciled(_fixture.GameDirectory, [_entry with { Enabled = false }], _fixture.InstanceRoot);

        var rendered = index.Records.GetRenderedDocument(Plugin, _npc).Value();

        Assert.Contains(NpcEditorId, rendered?.Text);
    }

    [Fact]
    public void APluginSourceThatFailsItsFirstRead_ReadsItsPluginFile_MarkedAsSuch_NamingTheFiles()
    {
        var backup = BackupOfTheNpcDocumentClaimingItsFormKeyAgain();

        using var index = Reconciled();

        Assert.Equal(NpcEditorId, index.DocumentOf(_npc, Plugin).EditorId);
        Assert.True(index.ReadFromItsPluginFileForItsUnreadableSource(Plugin));
        Assert.Empty(index.Status.Failures);
        Assert.Contains(index.SourceProblems(), problem => problem.SourceRelativePath == Relative(backup));
    }

    [Fact]
    public void APluginSourceThatFailsOnceRead_ReadsItsPluginFile_NotTheTreesLastRows_MarkedAsSuch()
    {
        using var index = Reconciled();
        var npc = index.DocumentOf(_npc, Plugin);
        index.Edit(_entry, npc, index.BodyOf(_npc, Plugin).Replace(NpcEditorId, "EditedInTheTree", StringComparison.Ordinal));
        Assert.Equal("EditedInTheTree", index.DocumentOf(_npc, Plugin).EditorId);

        BackupOfTheNpcDocumentClaimingItsFormKeyAgain();
        index.NextSnapshotUntil(
            () => index.ReadFromItsPluginFileForItsUnreadableSource(Plugin), "the plugin file read in its place");

        Assert.Equal(NpcEditorId, index.DocumentOf(_npc, Plugin).EditorId);
        Assert.Empty(index.Status.Failures);
    }

    [Fact]
    public void APluginSourceMended_IsReadFromItsTreeAgain_AtTheNextSnapshot()
    {
        using var index = Reconciled();
        var npc = index.DocumentOf(_npc, Plugin);
        index.Edit(_entry, npc, index.BodyOf(_npc, Plugin).Replace(NpcEditorId, "EditedInTheTree", StringComparison.Ordinal));
        var backup = BackupOfTheNpcDocumentClaimingItsFormKeyAgain();
        index.NextSnapshotUntil(
            () => index.ReadFromItsPluginFileForItsUnreadableSource(Plugin), "the plugin file read in its place");

        File.Delete(backup);
        index.NextSnapshotUntil(() => index.ReadFromItsPluginSource(Plugin), "the tree read again");

        Assert.Equal("EditedInTheTree", index.DocumentOf(_npc, Plugin).EditorId);
        Assert.Empty(index.SourceProblems());
    }

    [Fact]
    public void APluginSourceWrittenWhereThereWasNone_IsReadFromItsTree_AtTheNextSnapshot()
    {
        var aside = Path.Combine(_fixture.InstanceRoot, "aside");
        Directory.Move(SourceRoot, aside);
        using var index = Reconciled();
        Assert.True(index.ReadFromItsPluginFileForItsUnreadableSource(Plugin));

        Directory.Move(aside, SourceRoot);

        index.NextSnapshotUntil(() => index.ReadFromItsPluginSource(Plugin), "the tree read");
    }

    [Fact]
    public void APluginSourceRenamedAwayFromItsPluginFile_ReadsThePluginFile_MarkedAsSuch()
    {
        using var index = Reconciled();
        var npc = index.DocumentOf(_npc, Plugin);
        index.Edit(_entry, npc, index.BodyOf(_npc, Plugin).Replace(NpcEditorId, "EditedInTheTree", StringComparison.Ordinal));

        Directory.Move(SourceRoot, PluginSourceRoot.In(_entry.ModFolderOf(), "Renamed.esp"));

        index.NextSnapshotUntil(
            () => index.ReadFromItsPluginFileForItsUnreadableSource(Plugin), "the plugin file read in its place");
        Assert.Equal(NpcEditorId, index.DocumentOf(_npc, Plugin).EditorId);
    }
}
