using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Whole-plugin reads over a real tracked tree, with no index in the fixture: the working
/// tree's own documents, and the same question answered at a named ref through git.</summary>
public sealed class SourceRepositoryReadAllTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private const string EditedBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"EditedSinceCompile\"\n}";
    private const string LaterBody = "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"Later\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-readall-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    // The NPC's own relative path, spelled from the fixture's own constants rather than asked of the
    // repository: Track needs it to seed the pristine commit before any repository exists to ask.
    private static readonly string NpcRelativePath =
        Path.Combine("source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    // Track parks each plugin's last-compile ref at its baseline, so the ref this reads at is the one
    // Save & Compile parks.
    private SourceRepository Tracked()
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody))]);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    private static (string, string, string?, string) Tuple(SourceDocument document) =>
        (document.FormKey, document.RecordType, document.EditorId, document.Body);

    // The header's own document, at the tree's root. It declares a ModKey, never a FormKey, which is
    // why the FormKey it is filed under is PluginHeader's to compute.
    private static readonly string HeaderRelativePath =
        Path.Combine("source", PluginName, "RecordData.json");

    private const string HeaderBody = "{\n  \"ModKey\": \"Fixture.esp\",\n  \"MutagenObjectType\": \"Fallout4Mod\"\n}";

    private static string HeaderFormKey => PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

    private SourceRepository TrackedWithHeader()
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(HeaderRelativePath, Encoding.UTF8.GetBytes(HeaderBody)),
             new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody))]);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void ReadAll_AtTheWorkingTree_HoldsThePluginHeaderUnderTheFormKeyPluginHeaderComputes()
    {
        var header = TrackedWithHeader().ReadAll(Plugin).SingleOrDefault(d => d.FormKey == HeaderFormKey);

        Assert.NotNull(header);
        Assert.Equal(PluginHeader.RecordType, header.RecordType);
        Assert.Equal(HeaderBody, header.Body);
    }

    [Fact]
    public void ReadAll_AtARef_HoldsThePluginHeaderUnderTheFormKeyPluginHeaderComputes()
    {
        var header = TrackedWithHeader().ReadAll(Plugin, "refs/heads/main")
            .SingleOrDefault(d => d.FormKey == HeaderFormKey);

        Assert.NotNull(header);
        Assert.Equal(PluginHeader.RecordType, header.RecordType);
    }

    // The path a caller asks by is its own document's, so Get answers the header too.
    [Fact]
    public void GetAt_ThePluginHeader_IsTheCommittedHeaderDocument()
    {
        var repository = TrackedWithHeader();

        var header = repository.GetAt(
            Plugin, new RecordIdentity(HeaderFormKey, PluginHeader.RecordType, null), "refs/heads/main");

        Assert.Equal(HeaderBody, header?.Body);
    }

    [Fact]
    public void ReadAll_AtTheWorkingTree_IsEveryDocumentPut()
    {
        var repository = Tracked();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon",
            "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"FixtureWeapon\"\n}");
        var race = new SourceDocument("000A00:Fixture.esp", "race", null,
            "{\n  \"FormKey\": \"000A00:Fixture.esp\"\n}");
        repository.Put(Plugin, weapon);
        repository.Put(Plugin, race);

        var read = repository.ReadAll(Plugin);

        Assert.Equal(
            [(NpcFormKey, "npc_", NpcEditorId, NpcBody), Tuple(weapon), Tuple(race)],
            read.Select(Tuple).OrderBy(t => t.Item1, StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void ReadAll_AtTheWorkingTree_DropsARecordRemoved()
    {
        var repository = Tracked();

        repository.Remove(Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId));

        Assert.Empty(repository.ReadAll(Plugin));
    }

    [Fact]
    public void ReadAll_AtTheParkedCompileRef_IsTheCommittedTextNotTheWorkingTreesEdit()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, EditedBody));

        var parked = repository.ReadAll(Plugin, SourceRepository.LastCompileRef(PluginName));

        Assert.Equal([NpcBody], parked.Select(d => d.Body).ToList());
        Assert.Equal([EditedBody], repository.ReadAll(Plugin).Select(d => d.Body).ToList());
    }

    [Fact]
    public void ReadAll_AtTheParkedCompileRef_DoesNotSeeARecordCreatedSince()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument("000900:Fixture.esp", "weap", "Later", LaterBody));

        var parked = repository.ReadAll(Plugin, SourceRepository.LastCompileRef(PluginName));

        Assert.Equal([NpcFormKey], parked.Select(d => d.FormKey).ToList());
    }

    [Fact]
    public void ReadAll_AtARefThatHoldsNothingForThisPlugin_IsEmpty()
    {
        Assert.Empty(Tracked().ReadAll(new PluginAddress("Other.esp", "FixtureMod"), "refs/heads/main"));
    }

    [Fact]
    public void GetAt_TheParkedCompileRef_IsTheCommittedTextNotTheWorkingTreesEdit()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, EditedBody));

        var parked = repository.GetAt(
            Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId), SourceRepository.LastCompileRef(PluginName));

        Assert.Equal(NpcBody, parked?.Body);
    }

    [Fact]
    public void GetAt_ARecordTheRefNeverHeld_IsNull()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument("000900:Fixture.esp", "weap", "Later", LaterBody));

        Assert.Null(repository.GetAt(
            Plugin, new RecordIdentity("000900:Fixture.esp", "weap", "Later"),
            SourceRepository.LastCompileRef(PluginName)));
    }

    [Fact]
    public void ReadAll_AtTheWorkingTree_SkipsAFileUnderTheTreeThatDeclaresNoRecord()
    {
        var repository = Tracked();
        // Group metadata and a stray hand-written file both land here: what makes a file a document
        // is the FormKey it declares, not where it sits.
        var npcsFolder = Path.Combine(SourceRepository.RootIn(_modFolder, PluginName), "Npcs");
        File.WriteAllText(Path.Combine(npcsFolder, "GroupRecordData.json"), "{\n  \"Type\": \"npc_\"\n}");
        File.WriteAllText(Path.Combine(npcsFolder, "notes.json"), "{\n  \"Note\": \"scratch\"\n}");

        Assert.Equal([NpcFormKey], repository.ReadAll(Plugin).Select(d => d.FormKey).ToList());
    }
}
