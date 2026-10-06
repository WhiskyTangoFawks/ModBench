using System.Globalization;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;
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

    private sealed class RemovingTheDocumentOnReadingACopyToItsLeft(string document) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override IPluginRecordLookup OpenRecordLookup(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas)
        {
            File.Delete(document);
            return base.OpenRecordLookup(modPath, gameRelease, schemas);
        }
    }

    [Fact]
    public void AnUndeleteWhoseDocumentIsRemovedAfterItIsRead_IsRefusedAsSourceUnitNotFound_AndWritesNothing()
    {
        var edited = Address(_edited);
        var document = TreeTampering.FileOf(_plugins.FolderOf(_edited), edited, new RecordIdentity(Npc.ToString(), "npc_", null));
        var handler = TestEditService.Over(_plugins.Holder, adapter: new RemovingTheDocumentOnReadingACopyToItsLeft(document))
            .GetRequiredService<EditRecordHandler>();

        var result = handler.Edit(
            edited, Npc.ToString(), SetAt(JsonDocument.Parse(0.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.Contains(Npc.ToString(), result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(document));
    }
}
