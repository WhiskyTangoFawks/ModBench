using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 review (the Quest.Scenes finding): <see cref="ContainerAssembler"/> must REPLACE a
/// container's slot from <c>container_child</c>, never append onto whatever the record handed to it
/// already carries there.
///
/// <para><b>Not reachable through the real codec round trip today</b> — checked directly, not
/// assumed: <see cref="MEditService.Core.Serialization.RecordTextCodec"/>'s deserializer produces an
/// empty list for a child-major-group field regardless of what a parent's own ledger JSON prose says
/// (its <c>DiscardChildRecordStreams</c>/<c>NoRecordFolders</c> suppression is symmetric — write side
/// never inlines a child, read side never reads one back inline either), and Track's write never
/// inlined one — confirmed against real Track output both with and against the pre-#416
/// <c>ContainerStripFields</c> table. So today, nothing can hand <see cref="ContainerAssembler"/> a
/// Quest whose <c>Scenes</c> is already stale content from ledger text. This test exercises the
/// assembler's own replace behaviour directly at its own seam instead — insurance against whatever
/// *does* someday hand it a pre-populated slot (a future codec change, a hand-edited or third-party
/// tool's ledger write, root CLAUDE.md's never-assume-exclusive-ownership applied to this seam's own
/// caller, not only to the codec) — rather than a codec-round-trip test that would be vacuous by
/// construction against the current, verified-empty-on-read behaviour.</para>
/// </summary>
public sealed class CompileReplacesStaleContainerSlotsTests
{
    [Fact]
    public void Assemble_WhenTheHandedRecordAlreadyHasStaleSlotContent_ReplacesItRatherThanAppending()
    {
        const string pluginName = "Assembler.esp";
        var plugin = new PluginKey(pluginName, "Data");
        var reflector = SharedSchemaReflector.Instance;
        using var index = new DuckDbRecordIndex(reflector, new TableDdlBuilder(reflector), NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);

        // Index one container_child row: Quest -> (authoritative) Scene, "Scenes"[0].
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        var questTemplate = sourceMod.Quests.AddNew("MyQuest");
        var authoritativeScene = new Scene(FormKey.Factory($"F00801:{pluginName}"), Fallout4Release.Fallout4) { EditorID = "Authoritative" };
        questTemplate.Scenes.Add(authoritativeScene);
        index.Index((IModGetter)sourceMod, 0, participates: true, key: plugin);

        // The record ContainerAssembler is handed already carries stale content in the same slot —
        // never produced by today's codec (see the class doc), but not this seam's job to assume away.
        var quest = new Quest(questTemplate.FormKey, Fallout4Release.Fallout4) { EditorID = "MyQuest" };
        var staleScene = new Scene(FormKey.Factory($"F00802:{pluginName}"), Fallout4Release.Fallout4) { EditorID = "Stale" };
        quest.Scenes.Add(staleScene);

        var recordsByFormKey = new Dictionary<string, IMajorRecord>(StringComparer.Ordinal)
        {
            [quest.FormKey.ToString()] = quest,
            [authoritativeScene.FormKey.ToString()] = new Scene(authoritativeScene.FormKey, Fallout4Release.Fallout4) { EditorID = "Authoritative" },
        };

        var mod = ModFactory.Activator(ModKey.FromFileName(pluginName), GameRelease.Fallout4);
        var result = ContainerAssembler.Assemble(mod, recordsByFormKey, index, plugin);

        Assert.Empty(result.UnplaceableFormKeys);
        var assembledQuest = ((IFallout4ModGetter)mod).Quests.Single(q => q.FormKey == quest.FormKey);
        Assert.Single(assembledQuest.Scenes);
        Assert.Equal(authoritativeScene.FormKey, assembledQuest.Scenes[0].FormKey);
    }
}
