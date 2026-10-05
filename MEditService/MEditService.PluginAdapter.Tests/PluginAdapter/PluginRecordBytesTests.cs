using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginRecordBytesTests
{
    private const string PluginName = "DeletedNpc.esp";
    private static readonly FormKey Npc = FormKey.Factory("000800:DeletedNpc.esp");

    [Fact]
    public void HoldsNoFields_IsTrueForADeletedRecordWithNoSubrecord()
    {
        using var directory = new ScratchDirectory("plugin-record-bytes-");
        var path = Path.Combine(directory.Path, PluginName);
        DeletedNpcPlugin.WriteEmpty(path, Npc);

        var bytes = new PluginRecordBytes(new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4);

        Assert.True(bytes.HoldsNoFields(Npc));
    }

    [Fact]
    public void HoldsNoFields_IsFalseForARecordThatStillHoldsFields()
    {
        using var directory = new ScratchDirectory("plugin-record-bytes-");
        var path = Path.Combine(directory.Path, PluginName);
        DeletedNpcPlugin.WriteHoldingFields(path, Npc);

        var bytes = new PluginRecordBytes(new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4);

        Assert.False(bytes.HoldsNoFields(Npc));
    }

    [Fact]
    public void HoldsNoFields_IsFalseForARecordTheFileDoesNotHold()
    {
        using var directory = new ScratchDirectory("plugin-record-bytes-");
        var path = Path.Combine(directory.Path, PluginName);
        DeletedNpcPlugin.WriteEmpty(path, Npc);

        var bytes = new PluginRecordBytes(new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4);

        Assert.False(bytes.HoldsNoFields(FormKey.Factory("000801:DeletedNpc.esp")));
    }
}
