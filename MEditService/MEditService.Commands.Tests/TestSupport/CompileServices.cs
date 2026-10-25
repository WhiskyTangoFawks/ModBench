using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Compile as a client drives it: the handler, over a load order a test already has. The value
/// is snapshotted at the call, as the process's own holder is when the endpoint runs.</summary>
public static class CompileServices
{
    public static CompilePluginHandler Over(LoadOrderSnapshot loadOrder, IPluginAdapter? adapter = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return TestEditService.CompileHandler(holder, adapter);
    }

    /// <summary>Compiles a selection of one and fails with the refusal's message unless it landed.</summary>
    public static async Task CompileLandedAsync(this CompilePluginHandler handler, PluginAddress plugin)
    {
        var answer = await handler.CompileAsync([plugin]);
        var refusal = answer.Holds(out var result, out var whole) ? result.Refused.SingleOrDefault()?.Message : whole.Message;
        Assert.True(refusal is null && answer.Holds(out result, out _) && result.Applied.Count == 1, refusal);
    }

    /// <summary>Compiles <paramref name="plugin"/>, which must land, and reads the binary it wrote.</summary>
    public static async Task<IFallout4ModDisposableGetter> CompiledAsync(this TestInstance instance, PluginAddress plugin)
    {
        await instance.CompileHandler.CompileLandedAsync(plugin);
        return instance.Binary(plugin);
    }

    public static IFallout4ModDisposableGetter Binary(this TestInstance instance, PluginAddress plugin) =>
        Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(plugin.Name), Path.Combine(instance.ModFolderOf(plugin), plugin.Name)), Fallout4Release.Fallout4);
}
