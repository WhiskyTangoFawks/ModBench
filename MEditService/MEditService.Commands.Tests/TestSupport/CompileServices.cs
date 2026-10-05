using MEditService.Commands.Edits;
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

    /// <summary>A selection of one: its one answer as a <see cref="CompileResult"/>.</summary>
    public static async Task<CompileResult> CompileOneAsync(this CompilePluginHandler handler, PluginAddress plugin)
    {
        var answer = await handler.CompileAsync([plugin]);
        if (answer.SelectionRefusal is { } whole) return CompileResult.Refused(whole.Refusal, whole.Message);
        if (answer.Refused.SingleOrDefault() is { } refused) return CompileResult.Refused(refused.Refusal, refused.Message);
        return CompileResult.Success(answer.Landed.Single().Outcome);
    }
}
