using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

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

    private readonly ScratchDirectory _modFolder = new("medit-readall-");

    public void Dispose() => _modFolder.Dispose();

    private static readonly string NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk =
        Path.Combine("plugin-source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    private SourceRepository Tracked()
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    private static (string, string, string?, string) Tuple(SourceDocument document) =>
        (document.FormKey, document.RecordType, document.EditorId, document.Body);

    private static readonly string HeaderRelativePath =
        Path.Combine("plugin-source", PluginName, "RecordData.json");

    private const string HeaderBody = "{\n  \"ModKey\": \"Fixture.esp\",\n  \"MutagenObjectType\": \"Fallout4Mod\"\n}";

    private static string HeaderFormKey => PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

    private SourceRepository TrackedWithHeader()
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(HeaderRelativePath, Encoding.UTF8.GetBytes(HeaderBody)),
             new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
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
    public void NativeFormKeysHeldAt_TheParkedCompileRef_DoesNotSeeARecordCreatedSince()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument("000900:Fixture.esp", "weap", "Later", LaterBody));

        var parked = repository.NativeFormKeysHeldAt(Plugin, SourceRepository.LastCompileRef(PluginName));

        Assert.Equal([NpcFormKey], parked.ToList());
    }

    [Fact]
    public void NativeFormKeysHeldAt_ARefThatHoldsNothingForThisPlugin_IsEmpty()
    {
        Assert.Empty(Tracked().NativeFormKeysHeldAt(new PluginAddress("Other.esp", "FixtureMod"), "refs/heads/main"));
    }

    [Fact]
    public void ReadAll_AtTheWorkingTree_SkipsGroupMetadataAndAStrayFileDeclaringNoFormKey_ForADocumentIsWhatDeclaresAFormKeyNotWhereItSits()
    {
        var repository = Tracked();
        var npcsFolder = Path.Combine(SourceRepository.RootIn(_modFolder, PluginName), "Npcs");
        File.WriteAllText(Path.Combine(npcsFolder, "GroupRecordData.json"), "{\n  \"Type\": \"npc_\"\n}");
        File.WriteAllText(Path.Combine(npcsFolder, "notes.json"), "{\n  \"Note\": \"scratch\"\n}");

        Assert.Equal([NpcFormKey], repository.ReadAll(Plugin).Select(d => d.FormKey).ToList());
    }
}
