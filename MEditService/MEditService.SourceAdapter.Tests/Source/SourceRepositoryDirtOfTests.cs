using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>The tree's dirt as DirtOf sees it: which record an unstaged edit moved, and what a git
/// path under the plugin's own tree that names no record defers to (ADR-0003).</summary>
public sealed class SourceRepositoryDirtOfTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcFormKey = "000800:Test.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string EditedBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Edited\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "TestMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    // Spelled from the fixture's own constants rather than asked of the repository, matching
    // SourceRepositoryReadAllTests: Track needs it before any repository exists to ask.
    private static readonly string NpcRelativePath =
        Path.Combine("plugin-source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    private readonly ScratchDirectory _modFolder = new("medit-dirtof-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Tracked(params TreeFile[] extraFiles)
    {
        var files = new[] { new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody)) }.Concat(extraFiles).ToArray();
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, files);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void DirtOf_ReportsAnUnstagedEdit_ToAFileTrackAlreadyCommitted()
    {
        var repository = Tracked();

        // Plain unstaged edit — never `git add`ed. Put and a hand edit alike never stage, so a
        // rival that only checked the git index would report this clean.
        File.WriteAllText(Path.Combine(_modFolder, NpcRelativePath), EditedBody);

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
        Assert.False(dirt.NeedsStructuralPass);
    }

    // A rename's old path rides a bare token with no status code; read as an entry (entry[3..]),
    // losing three characters must land exactly on the real root.
    [Fact]
    public void DirtOf_OfAStagedRenameOutOfAFolderNamedLikeTheTree_FindsNothingToReconcile()
    {
        var rootSegment = SourceRepository.RootFor(PluginName).Split(Path.DirectorySeparatorChar)[0];
        var lookalikeFolderName = "xyz" + rootSegment;
        var oldFolder = Directory.CreateDirectory(Path.Combine(_modFolder, lookalikeFolderName, PluginName)).FullName;
        File.WriteAllText(Path.Combine(oldFolder, "notes.txt"), "notes");
        PluginBaselines.Track(_modFolder, SourcePreset.Everything, [new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody))]);
        var repository = SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv", $"{lookalikeFolderName}/{PluginName}/notes.txt", "notes.txt");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AStagedRename_NamesThePathItLeftWithHeadsText()
    {
        var repository = Tracked();
        var renamed = Path.Combine("plugin-source", PluginName, "Npcs", $"Renamed - 000800_{PluginName}.json");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "mv",
            NpcRelativePath.Replace('\\', '/'), renamed.Replace('\\', '/'));

        var dirt = repository.DirtOf(Plugin);

        Assert.Equal(2, dirt.Documents.Count);
        Assert.Contains(dirt.Documents, d => !d.InWorkingTree && d.CommittedText == NpcBody);
        Assert.Contains(dirt.Documents, d => d.InWorkingTree && d.CommittedText == null);
    }

    [Fact]
    public void DirtOf_AnEditToADocumentSortedBelowItsGroup_NamesItsRecordAsThatGroupsType()
    {
        var sortedPath = Path.Combine("plugin-source", PluginName, "Npcs", "SortedByHand", $"Sorted - 000900_{PluginName}.json");
        var repository = Tracked(new TreeFile(sortedPath, Encoding.UTF8.GetBytes($"{{\"FormKey\":\"000900:{PluginName}\"}}")));

        File.WriteAllText(Path.Combine(_modFolder, sortedPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Edited\"}}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal($"000900:{PluginName}", only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_ReportsNothing_ForACleanRepo()
    {
        var repository = Tracked();

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AWorkingTreeDeletion_NamesTheRecordAsGoneFromTheTree()
    {
        var repository = Tracked();

        File.Delete(Path.Combine(_modFolder, NpcRelativePath));

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.False(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
    }

    // The ordinary shape of a create: Put never runs git add, so the file is untracked and no ref
    // holds its text yet.
    [Fact]
    public void DirtOf_ADocumentNoRefHolds_NamesItWithNoCommittedText()
    {
        var repository = Tracked();
        // The Npcs folder Track already committed NpcRelativePath under, so no directory is minted.
        var createdPath = Path.Combine("plugin-source", PluginName, "Npcs", $"Created - 000900_{PluginName}.json");
        File.WriteAllText(
            Path.Combine(_modFolder, createdPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Created\"}}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal($"000900:{PluginName}", only.FormKey);
        Assert.Equal("npc_", only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.Null(only.CommittedText);
    }

    // The header's key is computed, never read off the document, so RecordData.json is the one
    // path DirtOf resolves to a record despite carrying no FormKey of its own.
    [Fact]
    public void DirtOf_ForTheHeadersOwnRecordDataJson_NamesItsComputedFormKey()
    {
        var headerPath = Path.Combine("plugin-source", PluginName, "RecordData.json");
        var repository = Tracked(new TreeFile(headerPath, "{\"MasterReferences\": []}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, headerPath), "{\"MasterReferences\": [], \"Changed\": true}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName)), only.FormKey);
        Assert.Equal(PluginHeader.RecordType, only.RecordType);
        Assert.True(only.InWorkingTree);
        Assert.False(dirt.NeedsStructuralPass);
    }

    // The rival: skip the structural-pass fallback and every one of these shapes reads as a clean
    // tree instead of one that needs a whole-tree compare.
    [Theory]
    // Too few path segments — the flat shape is at least four: plugin-source/<plugin>/<folder>/<file>.json.
    [InlineData("plugin-source/Test.esp/000800.json")]
    // Last segment missing the load-bearing ".json" suffix.
    [InlineData("plugin-source/Test.esp/Npcs/000800.txt")]
    [InlineData("plugin-source/Test.esp/Npcs/000800")]
    // The whole-mod door's own header/group files, at the wrong depth — never a flat record's own file.
    [InlineData("plugin-source/Test.esp/Npcs/RecordData.json")]
    [InlineData("plugin-source/Test.esp/Cells/GroupRecordData.json")]
    // A folder this game's schema has no group for at all.
    [InlineData("plugin-source/Test.esp/NotARealFolder/000800.json")]
    // Three segments but not literally RecordData.json — must not be mistaken for the header.
    [InlineData("plugin-source/Test.esp/NotRecordData.json")]
    public void DirtOf_APathUnderThePluginsTreeThatFailsToParse_DefersToTheStructuralPass_NeverAsARecord(
        string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked(new TreeFile(normalized, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.True(dirt.NeedsStructuralPass);
    }

    // An abstract group element reads as ambiguous, the same policy as the whole-mod door's own
    // discriminator: the path alone cannot say which concrete type the folder holds.
    [Fact]
    public void DirtOf_ForAPathUnderAnAmbiguousGroupsFolder_DefersToTheStructuralPass()
    {
        var folder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var relativePath = Path.Combine("plugin-source", PluginName, folder, $"SomeGlobal - 000800_{PluginName}.json");
        var repository = Tracked(new TreeFile(relativePath, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, relativePath), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.True(dirt.NeedsStructuralPass);
    }

    // Outside this plugin's own tree entirely: not even a candidate for the structural pass, which
    // only ever fires under the plugin's own root.
    [Theory]
    // No "plugin-source" root at all: the plugin would sit directly at the mod folder's own root.
    [InlineData("Test.esp/Npcs/000800.json")]
    // A root segment present, but not the literal name "plugin-source".
    [InlineData("NotPluginSource/Test.esp/Npcs/000800.json")]
    public void DirtOf_APathOutsideThePluginsTree_IsIgnoredEntirely(string relativePath)
    {
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
        var repository = Tracked();

        Directory.CreateDirectory(Path.Combine(_modFolder, Path.GetDirectoryName(normalized) ?? ""));
        File.WriteAllText(Path.Combine(_modFolder, normalized), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }
}
