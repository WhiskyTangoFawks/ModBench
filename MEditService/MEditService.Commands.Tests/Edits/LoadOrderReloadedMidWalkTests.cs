using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class LoadOrderReloadedMidWalkTests : IDisposable
{
    private const int Deleted = 0x0020;
    private static readonly FormKey TheNpc = new(Fallout4Esm, 0x900);

    private readonly LoadOrderOfPlugins _plugins = new();

    public void Dispose() => _plugins.Dispose();

    private sealed class DroppingFallout4OnTheFirstRead(LoadOrderHolder holder)
        : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private bool _dropped;

        public override IPluginRecordLookup OpenRecordLookup(
            RegisteredPlugin plugin, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas)
        {
            if (!_dropped)
            {
                _dropped = true;
                var held = holder.Current;
                holder.Apply(new LoadOrderSnapshot(
                    held.DataFolderPath, held.InstanceRoot, held.GameRelease,
                    [.. held.Plugins.Where(p => p.Name != Fallout4Esm.FileName)],
                    [.. held.Active.Where(p => p.Name != Fallout4Esm.FileName).Select(p => p.Key)],
                    [.. held.LoadedWithNoLine.Where(p => p.Name != Fallout4Esm.FileName).Select(p => p.Key)]));
            }
            return base.OpenRecordLookup(plugin, gameRelease, schemas);
        }
    }

    [Fact]
    public void ClearingDeleted_WhenTheLoadOrderIsReplacedMidWalk_ReadsEveryCopyFromTheSnapshotItWalks()
    {
        var mid = Plugin("Mid.esp", mod => mod.Npcs.Add(new Npc(new FormKey(ModKey.FromFileName("Mid.esp"), 0x950), Fallout4Release.Fallout4)));
        var edited = Plugin("Override.esp", mod =>
        {
            mod.ModHeader.MasterReferences.Add(new MasterReference { Master = mid.ModKey });
            mod.Npcs.Add(new Npc(new FormKey(mid.ModKey, 0x950), Fallout4Release.Fallout4));
            mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted });
        });
        _plugins.Load(
            (Plugin("Fallout4.esm", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { EditorID = "Guy" })), false),
            (mid, false),
            (edited, true));
        var handler = new TestEditor(
            TestEditService.Over(_plugins.Holder, adapter: new DroppingFallout4OnTheFirstRead(_plugins.Holder))
                .GetRequiredService<EditRecordChangesHandler>(),
            _plugins.Holder);

        var result = handler.Set(Address(edited), TheNpc.ToString(), "MajorRecordFlagsRaw", JsonDocument.Parse("0").RootElement);

        Assert.True(result.Applied, result.Message);
        Assert.Equal("Guy", JsonNode.Parse(_plugins.Text(edited, TheNpc))?["EditorID"]?.GetValue<string>());
    }
}
