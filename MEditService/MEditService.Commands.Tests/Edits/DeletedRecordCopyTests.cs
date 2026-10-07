using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeletedRecordCopyTests : IDisposable
{
    private const int Deleted = 0x0020;

    private static readonly FormKey TheNpc = new(Fallout4Esm, 0x900);

    private readonly LoadOrderOfPlugins _plugins = new();

    public void Dispose() => _plugins.Dispose();

    [Fact]
    public void CopyAsOverride_OfADeletedRecordAnUntrackedPluginHolds_LandsItDeleted()
    {
        var deleting = Plugin("Deleting.esp", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted }));
        var patch = Plugin("Patch.esp", _ => { });
        _plugins.Load(
            (Plugin("Fallout4.esm", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { EditorID = "Guy" })), false),
            (deleting, false),
            (patch, true));

        var result = _plugins.CopyHandler.CopySync([new RecordAt(Address(deleting), TheNpc.ToString())], CopyMode.Override, [Address(patch)], replace: false);

        result.OnlyLanded();
        var landed = JsonNode.Parse(_plugins.Text(patch, TheNpc)).Require();
        Assert.Equal(Deleted, landed["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Null(landed["EditorID"]);
    }

    [Fact]
    public void CopyAsOverride_OfADeletedRecordThatStillHoldsFieldsItCannotRead_IsRefused_AndWritesNothing()
    {
        var deleting = Plugin("Deleting.esp", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted }));
        var patch = Plugin("Patch.esp", _ => { });
        _plugins.Load(
            (Plugin("Fallout4.esm", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { EditorID = "Guy" })), false),
            (deleting, false),
            (patch, true));
        _plugins.Rewrite(deleting, path => DeletedNpcPlugin.WriteHoldingFields(path, TheNpc, Fallout4Esm));

        var result = _plugins.CopyHandler.CopySync([new RecordAt(Address(deleting), TheNpc.ToString())], CopyMode.Override, [Address(patch)], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Throws<InvalidOperationException>(() => _plugins.Text(patch, TheNpc));
    }
}
