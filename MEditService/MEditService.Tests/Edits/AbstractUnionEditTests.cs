using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// The write half of the general abstract Loqui union mechanism
/// (<c>SchemaReflector.ResolveAbstractUnionConcreteType</c>) for its two mandatory types —
/// <c>Npc.Level</c> (<c>BuildStructColumn</c>'s own single-object discriminator resolution) and
/// <c>Quest.Aliases</c> (<c>ApplyListJson</c>'s <c>ResolveAbstractListElementType</c>, generalized
/// beyond the OMOD-only case). Same posture as <see cref="ComplexFieldElementEditTests"/>'s own
/// <c>OmodFixture</c> — a real mod folder, a real tracked load order, no mocks; the edit lands as a
/// real Mutagen binary write/re-parse round trip through <c>RecordEditService</c>. Verified against the
/// written source document's own text (same idiom <c>ComplexFieldElementEditTests</c> already uses for
/// OMOD's own leaf-union), since the document's own serializer shape has no per-column correspondence
/// to the reflected schema's json_extract shape (MEditService/CLAUDE.md).
/// </summary>
public sealed class AbstractUnionEditTests : IDisposable
{
    private readonly AbstractUnionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ── Npc.Level ────────────────────────────────────────────────────────────

    [Fact]
    public void Level_EditingWithinSameConcreteType_RoundTrips()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level",
            Json("""{"level": 20, "concrete_type": "NpcLevel"}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.NpcBody();
        Assert.Contains("NpcLevel", body, StringComparison.Ordinal);
        Assert.Contains("20", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Level_SwitchingConcreteType_NpcLevelToPcLevelMult_RoundTrips()
    {
        // The fixture NPC starts as a NpcLevel(5) — this switches its Level to the other leaf
        // entirely, which cannot reuse the old NpcLevel instance.
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level",
            Json("""{"level_mult": 1.5, "concrete_type": "PcLevelMult"}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.NpcBody();
        Assert.Contains("PcLevelMult", body, StringComparison.Ordinal);
        Assert.DoesNotContain("NpcLevel", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Level_MissingDiscriminator_IsRefusedAndWritesNothing()
    {
        var before = _fixture.NpcBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level", Json("""{"level": 20}"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.NpcBody());
    }

    [Fact]
    public void Level_UnrecognizedDiscriminator_IsRefusedAndWritesNothing()
    {
        var before = _fixture.NpcBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level",
            Json("""{"level": 20, "concrete_type": "NotARealLevelShape"}"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.NpcBody());
    }

    // ── Quest.Aliases ────────────────────────────────────────────────────────

    /// <summary>
    /// The writable-siblings-only shape: no nested struct named at all. This fact previously
    /// included a <c>location</c> payload and asserted only <c>Applied == true</c> plus two
    /// unrelated substrings, so it never actually checked <c>name</c>/<c>closest_to_alias</c>
    /// landed — it was passing while <c>ApplySubFields</c> silently discarded <c>location</c> the
    /// whole time (#642's own defect hiding inside a test named "RoundTrips" that never completed
    /// its round trip). This version proves the round trip its name promises;
    /// <see cref="Aliases_WholeArrayWrite_QuestReferenceAliasElement_LocationNamedInPayload_RoundTrips"/>
    /// is the <c>location</c> half, made writable by #643.
    /// </summary>
    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_RoundTrips()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""[{"concrete_type": "QuestReferenceAlias", "name": "NewRef", "closest_to_alias": 4}]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("QuestReferenceAlias", body, StringComparison.Ordinal);
        Assert.Contains("\"Name\": \"NewRef\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ClosestToAlias\": 4", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// #643: the third instance of #642's own defect (beyond the two named in that ticket) —
    /// <c>QuestReferenceAlias.Location</c> is a Loqui struct nested one level inside an
    /// <c>AQuestAlias</c> array element, not a top-level struct column, so it is reached through
    /// <c>ApplyListJson</c>/<c>BuildListElement</c> rather than <c>BuildStructColumn</c> directly.
    /// #642 pinned an honest refusal here while nothing wrote nested structs; this replaces that pin
    /// with the round trip #643 makes real — and asserts the nested value itself landed in the
    /// written document, not just <c>Applied == true</c>, precisely because the original
    /// "RoundTrips" fact sat green for months while <c>ApplySubFields</c> discarded
    /// <c>location</c> (read coverage of the same field was already correct —
    /// <c>AbstractUnionSchemaTests</c> asserts <c>location.alias_id</c> round-trips on read — the
    /// #360 divergence this ticket closes).
    /// </summary>
    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_LocationNamedInPayload_RoundTrips()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""
            [{"concrete_type": "QuestReferenceAlias", "name": "NewRef", "closest_to_alias": 4,
              "location": {"alias_id": 9}}]
            """));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("\"Name\": \"NewRef\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Location\"", body, StringComparison.Ordinal);
        Assert.Contains("\"AliasID\": 9", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Aliases_WholeArrayWrite_QuestCollectionAliasElement_RoundTrips()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""[{"concrete_type": "QuestCollectionAlias"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("QuestCollectionAlias", body, StringComparison.Ordinal);
        Assert.DoesNotContain("OriginalLoc", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// #643's fold repair: a nested list member whose own element type can't be resolved
    /// (<c>conditions</c> — element type <c>Condition</c>, which exposes no <c>concrete_type</c>
    /// by documented exclusion, so no payload can ever resolve it) must refuse the whole write.
    /// Before the repair, <c>ApplySubFields</c>' fold recognized only
    /// <c>SubFieldReadOnly</c>/<c>ValueRejected</c> and silently swallowed
    /// <c>ListElementTypeUnresolved</c> from a nested list's own apply — this exact payload
    /// reported success while the new alias element landed with its <c>conditions</c> silently
    /// empty, the same silent-discard class #642 closed for nested structs, one shape over.
    /// </summary>
    [Fact]
    public void Aliases_ElementWithUnresolvableNestedConditionElement_IsRefusedAndWritesNothing()
    {
        var before = _fixture.QuestBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""
            [{"concrete_type": "QuestReferenceAlias", "name": "NewRef",
              "conditions": [{"comparison_value": 1.0}]}]
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ListElementTypeUnresolved, result.Refusal);
        Assert.Equal(before, _fixture.QuestBody());
    }

    [Fact]
    public void Aliases_UnrecognizedElementDiscriminator_IsRefusedAndWritesNothing()
    {
        var before = _fixture.QuestBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""[{"concrete_type": "NotARealAliasKind", "name": "X"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.QuestBody());
    }

    private sealed class AbstractUnionFixture : IDisposable
    {
        private const string PluginName = "AbstractUnion548.esp";
        private const string Origin = "AbstractUnion548Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-548-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-548-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Npc { get; }
        public FormKey Quest { get; }

        public AbstractUnionFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var npc = new Npc(mod.GetNextFormKey("Npc548"), Fallout4Release.Fallout4)
            {
                EditorID = "Npc548",
                Level = new NpcLevel { Level = 5 },
            };
            mod.Npcs.Add(npc);
            Npc = npc.FormKey;

            var quest = new Quest(mod.GetNextFormKey("Quest548"), Fallout4Release.Fallout4)
            {
                EditorID = "Quest548",
                Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }],
            };
            mod.Quests.Add(quest);
            Quest = quest.FormKey;

            mod.WriteToBinary(pluginPath);

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string NpcBody() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Npc.ToString(), Plugin)!.Body!;
        public string QuestBody() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Quest.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
