using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The repository's document verbs against a real tracked tree with no index anywhere in
/// the fixture: a mod folder, git, and the files Track committed (ADR-0046 invariant 9).</summary>
public sealed class SourceRepositoryDocumentTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginKey Plugin = new(PluginName, "FixtureMod");
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", NpcEditorId);

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-repository-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    // Track rather than a hand-made .git: the repository the tests open is the one the product makes.
    private void Track(params PristineFile[] files) =>
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

    private static PristineFile Npc0800 =>
        new(SourceRepository.FlatPathFor(PluginName, "npc_", NpcFormKey, NpcEditorId, GameRelease.Fallout4),
            System.Text.Encoding.UTF8.GetBytes(NpcBody));

    // Asserted against directly: "the file moved" and "the file is gone" are claims about the tree,
    // and asking the repository for them would only echo its own rule back.
    private string NpcGroupFolder =>
        Path.GetDirectoryName(Path.Combine(
            _modFolder, SourceRepository.FlatPathFor(PluginName, "npc_", NpcFormKey, NpcEditorId, GameRelease.Fallout4)))!;

    private SourceRepository Opened()
    {
        Track(Npc0800);
        return SourceRepository.Open(_modFolder, GameRelease.Fallout4)!;
    }

    [Fact]
    public void Open_OnAnUntrackedFolder_IsNull()
    {
        Assert.Null(SourceRepository.Open(_modFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void Open_OnATrackedFolder_IsARepository()
    {
        Track(Npc0800);

        Assert.NotNull(SourceRepository.Open(_modFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void Get_OfAFlatRecordTheTreeHolds_IsItsOwnText()
    {
        var document = Opened().Get(Plugin, Npc);

        Assert.NotNull(document);
        Assert.Equal(NpcBody, document.Body);
        Assert.Equal(NpcFormKey, document.FormKey);
        Assert.Equal("npc_", document.RecordType);
    }

    [Fact]
    public void Get_OfARecordNoFileHolds_IsNull()
    {
        Assert.Null(Opened().Get(Plugin, new RecordIdentity("000801:Fixture.esp", "npc_", "Absent")));
    }

    [Fact]
    public void Put_OfARecordTheTreeHasNeverHeld_ThenGet_RoundTripsItsText()
    {
        var repository = Opened();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", "{\"EditorID\": \"FixtureWeapon\"}");

        repository.Put(Plugin, weapon);

        Assert.Equal(weapon.Body, repository.Get(Plugin, new RecordIdentity(weapon.FormKey, "weap", "FixtureWeapon"))?.Body);
    }

    [Fact]
    public void Put_OverARecordTheTreeAlreadyHolds_ReplacesItsText()
    {
        var repository = Opened();

        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, "{\"EditorID\": \"FixtureNpc\"}"));

        Assert.Equal("{\"EditorID\": \"FixtureNpc\"}", repository.Get(Plugin, Npc)?.Body);
    }

    [Fact]
    public void Remove_OfARecordTheTreeHolds_LeavesNoFileHoldingIt()
    {
        var repository = Opened();

        repository.Remove(Plugin, Npc);

        Assert.Null(repository.Get(Plugin, Npc));
        Assert.Empty(Directory.EnumerateFiles(NpcGroupFolder));
    }

    [Fact]
    public void Remove_OfARecordNoFileHolds_IsTheStateItAsksFor_NotAThrow()
    {
        var repository = Opened();

        // A type this plugin has never held, so not even its group folder exists — the shape a hand
        // delete or another tool leaves behind.
        repository.Remove(Plugin, new RecordIdentity("000900:Fixture.esp", "weap", "Absent"));

        Assert.NotNull(repository.Get(Plugin, Npc));
    }

    [Fact]
    public void Rename_MovesTheFileToTheNameTheNewEditorIdComputes_AndGetStillFindsItByFormKey()
    {
        var repository = Opened();

        repository.Rename(Plugin, Npc, "RenamedNpc");

        Assert.Equal(
            [$"RenamedNpc - 000800_{PluginName}.json"],
            Directory.EnumerateFiles(NpcGroupFolder).Select(Path.GetFileName).ToList());
        Assert.Equal(NpcBody, repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", "RenamedNpc"))?.Body);
    }

    [Fact]
    public void Get_AfterSomethingElseRenamedTheFile_StillFindsItByFormKey()
    {
        var repository = Opened();
        // Never assume exclusive ownership: xEdit, MO2 or the author can rename the file at any time,
        // and the identity the caller holds still names the record inside it.
        File.Move(
            Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"),
            Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json"));

        Assert.Equal(NpcBody, repository.Get(Plugin, Npc)?.Body);
    }

    [Fact]
    public void Rename_ToTheEditorIdTheRecordAlreadyHas_LeavesAFileSomethingElseRenamedWhereItIs()
    {
        var repository = Opened();
        var renamed = Path.Combine(NpcGroupFolder, $"RenamedOutside - 000800_{PluginName}.json");
        File.Move(Path.Combine(NpcGroupFolder, $"{NpcEditorId} - 000800_{PluginName}.json"), renamed);

        repository.Rename(Plugin, Npc, NpcEditorId);

        Assert.Equal(
            [Path.GetFileName(renamed)],
            Directory.EnumerateFiles(NpcGroupFolder).Select(Path.GetFileName).ToList());
    }

    [Fact]
    public void Get_WhenTwoFilesInTheGroupFolderClaimOneFormKey_Refuses()
    {
        var repository = Opened();
        File.WriteAllText(Path.Combine(NpcGroupFolder, $"AnImpostor - 000800_{PluginName}.json"), NpcBody);

        // A FormKey is unique within a mod, so answering with either file would be a guess.
        var refusal = Assert.Throws<AmbiguousSourceUnitException>(
            () => repository.Get(Plugin, new RecordIdentity(NpcFormKey, "npc_", "NeitherName")));

        Assert.Contains(NpcFormKey, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfTheHeader_IsTheRootRecordDocument()
    {
        Track(
            Npc0800,
            new PristineFile(
                Path.Combine("source", PluginName, "RecordData.json"),
                System.Text.Encoding.UTF8.GetBytes("{\"MasterReferences\": []}")));
        var repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4)!;

        var header = new RecordIdentity($"000000:{PluginName}", "header", null);

        Assert.Equal("{\"MasterReferences\": []}", repository.Get(Plugin, header)?.Body);
    }
}
