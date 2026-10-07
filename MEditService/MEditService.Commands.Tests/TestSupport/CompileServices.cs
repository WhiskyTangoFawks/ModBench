using MEditService.LoadOrder;
using MEditService.PluginAdapter;

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
        var refusal = answer.SelectionRefusal?.Message ?? answer.Refused.SingleOrDefault()?.Message;
        Assert.True(refusal is null && answer.Landed.Count == 1, refusal);
    }
}
