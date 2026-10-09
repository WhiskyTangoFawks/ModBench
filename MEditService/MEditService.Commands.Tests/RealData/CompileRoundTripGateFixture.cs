using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The cut-down plugin tracked, edited at a flat record and at a response its quest's
/// document carries, then compiled once. The compiled binary is kept apart from the mod folder, which
/// a later compile writes again.</summary>
public sealed class CompileRoundTripGateFixture : IDisposable
{
    private readonly ScratchDirectory _gameDirectory = new("medit-compile-roundtrip-game-");
    private readonly ScratchDirectory _compiledFolder = new("medit-compile-roundtrip-compiled-");

    public PluginAddress Plugin { get; } = new(CutDownPluginFixture.PluginFileName, "FixtureMod");
    public ScratchDirectory ModFolder { get; } = new("medit-compile-roundtrip-");
    public string PluginPath => Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
    public LoadOrderHolder Holder { get; } = new();

    public Dictionary<string, byte[]> TrackedTree { get; }
    public Dictionary<string, byte[]> EditedTree { get; }
    public IReadOnlyList<string> EditedDocuments { get; }

    public FormKey Npc { get; }
    public FormKey Topic { get; }
    public IReadOnlyList<FormKey> TopicResponses { get; }
    public FormKey RenamedResponse { get; }
    public string RenamedResponseEditorId { get; }

    public string CompiledPluginPath => Path.Combine(_compiledFolder, CutDownPluginFixture.PluginFileName);

    public CompileRoundTripGateFixture()
    {
        CutDownPluginFixture.TrackedInto(ModFolder);
        Holder.Apply(SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, PluginPath, Plugin.Origin, Line: 0, Enabled: true, Winning: true)]));
        TrackedTree = CutDownPluginFixture.ReadSourceTree(ModFolder);

        using (var original = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4))
        {
            var mod = (IFallout4ModGetter)original;
            var npc = mod.Npcs.First();
            // The middle response: renaming an edge one would mask a renumbering bug that shifts
            // the responses after it.
            var (quest, topic) = mod.Quests
                .SelectMany(q => q.DialogTopics.Select(t => (Quest: q, Topic: t)))
                .First(qt => qt.Topic.Responses.Count >= 3 && !string.IsNullOrEmpty(qt.Topic.Responses[1].EditorID));
            var response = topic.Responses[1];

            (Npc, Topic, RenamedResponse) = (npc.FormKey, topic.FormKey, response.FormKey);
            TopicResponses = [.. topic.Responses.Select(r => r.FormKey)];
            RenamedResponseEditorId = response.EditorID + "Renamed";
            EditedDocuments = [.. new[] { Npc.ToString(), quest.FormKey.ToString() }.Order(StringComparer.Ordinal)];
        }

        var edit = TestEditService.EditHandler(Holder);
        Require(edit.Set(Plugin, Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement));
        Require(edit.Set(Plugin, RenamedResponse.ToString(), "EditorID",
            JsonDocument.Parse(JsonSerializer.Serialize(RenamedResponseEditorId)).RootElement));
        EditedTree = CutDownPluginFixture.ReadSourceTree(ModFolder);

        CompileService().CompileLandedAsync(Plugin).GetAwaiter().GetResult();
        File.Copy(PluginPath, CompiledPluginPath);
    }

    private static void Require(RecordEditResult result)
    {
        if (!result.Applied) throw new InvalidOperationException($"Expected the fixture's edit to land: {result.Message}");
    }

    public CompilePluginHandler CompileService() => CompileServices.Over(Holder.Current);

    public void Dispose()
    {
        ModFolder.Dispose();
        _compiledFolder.Dispose();
        _gameDirectory.Dispose();
    }
}
