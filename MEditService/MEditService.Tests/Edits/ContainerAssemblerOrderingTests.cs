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
/// <see cref="ContainerAssembler"/> restores a container slot in the order the plugin held it, not
/// in whatever order is convenient to iterate. Compile writes the binary from what this produces, so
/// a reordered list is a silent content change in the user's plugin — and, through the codec, in
/// every affected record's source text.
///
/// <para><b>Two ordering sources, because there are two kinds of slot</b>, and #450 review caught
/// this class of defect once in each direction:</para>
/// <list type="bullet">
/// <item>The slots Spriggit <b>embeds</b> (<c>Cell.Persistent</c>/<c>Temporary</c>, attached from
/// <c>placement</c>, which has no ordering column) take their order from the <i>parent document's
/// own</i> in-memory list, which since #450 carries the children inline. Attaching those by FormKey
/// instead rewrote every populated cell's ref lists; caught by the #369 real-fixture compile gate on
/// cell <c>018AA2</c>.</item>
/// <item>The slots that stay <b>folder-split</b> (<c>Quest.DialogBranches</c>/<c>DialogTopics</c>,
/// <c>DialogTopic.Responses</c>, attached from <c>container_child</c>) take their order from the
/// <c>slot_index</c> captured at ingest — because the codec's child-stream suppressions mean the
/// parent's own slot is <i>always empty</i> when the assembler runs, so there is no document order to
/// read. This test is that second case: the real fixture only catches it if its own lists happen to
/// be held out of FormKey order, which is not a property any fixture guarantees.</item>
/// </list>
/// </summary>
public sealed class ContainerAssemblerOrderingTests
{
    /// <summary>
    /// Deliberately held in an order that is <b>not</b> FormKey-ascending: the high FormKey occupies
    /// <c>slot_index</c> 0. A FormKey-ordered assembler produces the exact reverse, so this fails on
    /// the difference between "ordered somehow, deterministically" and "ordered the way the plugin
    /// had it" — the two are indistinguishable on any fixture whose lists are already sorted.
    /// </summary>
    [Fact]
    public void Assemble_ForAFolderSplitSlot_RestoresTheIngestedSlotOrder_NotFormKeyOrder()
    {
        const string pluginName = "AssemblerOrdering.esp";
        var plugin = new PluginKey(pluginName, "Data");
        var reflector = SharedSchemaReflector.Instance;
        using var index = new DuckDbRecordIndex(reflector, new TableDdlBuilder(reflector), NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);

        var highFormKey = FormKey.Factory($"F00802:{pluginName}");
        var lowFormKey = FormKey.Factory($"F00801:{pluginName}");

        var sourceMod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        var questTemplate = sourceMod.Quests.AddNew("OrderedQuest");
        questTemplate.DialogTopics.Add(new DialogTopic(highFormKey, Fallout4Release.Fallout4) { EditorID = "TopicFirst" });
        questTemplate.DialogTopics.Add(new DialogTopic(lowFormKey, Fallout4Release.Fallout4) { EditorID = "TopicSecond" });
        index.Index((IModGetter)sourceMod, 0, participates: true, key: plugin);

        // What compile hands the assembler: each record deserialized from its own source file. The
        // quest's DialogTopics is empty here because that is what the codec produces for a
        // folder-split child group — the very reason slot_index has to be the ordering source.
        var quest = new Quest(questTemplate.FormKey, Fallout4Release.Fallout4) { EditorID = "OrderedQuest" };
        var recordsByFormKey = new Dictionary<string, IMajorRecord>(StringComparer.Ordinal)
        {
            [quest.FormKey.ToString()] = quest,
            [highFormKey.ToString()] = new DialogTopic(highFormKey, Fallout4Release.Fallout4) { EditorID = "TopicFirst" },
            [lowFormKey.ToString()] = new DialogTopic(lowFormKey, Fallout4Release.Fallout4) { EditorID = "TopicSecond" },
        };

        var mod = ModFactory.Activator(ModKey.FromFileName(pluginName), GameRelease.Fallout4);
        var result = ContainerAssembler.Assemble(mod, recordsByFormKey, index, plugin);

        Assert.Empty(result.UnplaceableFormKeys);
        var assembled = ((IFallout4ModGetter)mod).Quests.Single(q => q.FormKey == quest.FormKey);
        Assert.Equal(
            ["TopicFirst", "TopicSecond"],
            assembled.DialogTopics.Select(t => t.EditorID!).ToArray());
    }
}
