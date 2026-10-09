using System.Text.Json;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class RecordRemovedMidEditTests : IDisposable
{
    private const int Deleted = 0x0020;
    private static readonly FormKey Npc = new(Fallout4Esm, 0x800);

    private readonly LoadOrderOfPlugins _plugins = new();
    private readonly Fallout4Mod _edited;

    public RecordRemovedMidEditTests()
    {
        var master = Plugin("Fallout4.esm", mod => mod.Npcs.Add(new Npc(Npc, Fallout4Release.Fallout4) { EditorID = "Guy" }));
        _edited = Plugin("Override.esp", mod => mod.Npcs.Add(new Npc(Npc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted }));
        _plugins.Load((master, false), (_edited, true));
    }

    public void Dispose() => _plugins.Dispose();

    private sealed class RemovingTheDocumentOnReadingACopyToItsLeft(string document, string modFolder)
        : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        internal IReadOnlyList<string> TreeAsRemoved { get; private set; } = [];

        public override PluginAnswer<IPluginRecords> OpenRecordLookup(
            RegisteredPlugin plugin, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas)
        {
            File.Delete(document);
            TreeAsRemoved = TreeSnapshot.Of(modFolder);
            return base.OpenRecordLookup(plugin, gameRelease, schemas);
        }
    }

    [Fact]
    public void AnUndeleteWhoseDocumentIsRemovedAfterItIsRead_IsRefusedAsSourceUnitNotFound_AndAnswersNoChanges()
    {
        var edited = Address(_edited);
        var modFolder = _plugins.FolderOf(_edited);
        var remover = new RemovingTheDocumentOnReadingACopyToItsLeft(
            TreeTampering.FileOf(modFolder, edited, new RecordIdentity(Npc.ToString(), "npc_", null)), modFolder);
        var handler = new TestEditor(TestEditService.Over(_plugins.Holder, adapter: remover).GetRequiredService<EditRecordChangesHandler>());

        var result = handler.Set(edited, Npc.ToString(), "MajorRecordFlagsRaw", JsonDocument.Parse("0").RootElement);

        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.Contains(Npc.ToString(), result.Message, StringComparison.Ordinal);
        Assert.EndsWith("It was moved or removed outside Modbench. Check the Source Control panel.", result.Message, StringComparison.Ordinal);
        Assert.Equal(1, Regex.Count(result.Message, "outside Modbench"));
        Assert.NotEmpty(remover.TreeAsRemoved);
        Assert.Equal(remover.TreeAsRemoved, TreeSnapshot.Of(modFolder));
    }
}
