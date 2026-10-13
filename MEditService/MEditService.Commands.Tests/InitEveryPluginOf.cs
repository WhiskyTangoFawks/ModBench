using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests;

/// <summary>A fixture's init of one mod, through the handler over a held copy of the load order.</summary>
internal static class InitEveryPluginOf
{
    internal static Task<SelectionResult<string, InitRefusal, InitializedMod>> ModAsync(
        LoadOrderSnapshot loadOrder, string mod, IPluginAdapter? adapter = null, INotificationPublisher? notifications = null,
        ISourceAdapter? source = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return TestEditService.InitHandler(holder, adapter, notifications, source).InitAsync(ToInit.Named(mod));
    }

    /// <summary>Every reason something of the selection did not init, whole mods and single plugins alike.</summary>
    internal static List<string> RefusalMessages(this SelectionResult<string, InitRefusal, InitializedMod> result) =>
    [
        .. result.SelectionRefusal is { } refusal ? [refusal.Message] : Enumerable.Empty<string>(),
        .. result.Refused.Select(r => r.Message),
    ];

    /// <summary>The answer for a selection of one mod holding one plugin.</summary>
    internal static PluginInit Only(this SelectionResult<string, InitRefusal, InitializedMod> result) =>
        result switch
        {
            { SelectionRefusal: { } refusal } => new PluginInit(false, refusal.Refusal, refusal.Message),
            { Landed: [{ Outcome: { Plugins.Count: 1 } }], Refused.Count: 0 } => new PluginInit(true, InitRefusal.None, ""),
            { Landed.Count: 0, Refused: [var refused] } => new PluginInit(false, refused.Refusal, refused.Message),
            _ => throw new InvalidOperationException(
                $"Expected one plugin's answer, got {result.Landed.Count} landed and {result.Refused.Count} refused."),
        };
}

internal sealed record PluginInit(bool Applied, InitRefusal Refusal, string Message);

/// <summary>Mods to init as the extension hands a mod with no installation file and no file of the mod manager's.</summary>
internal static class ToInit
{
    internal static IReadOnlyList<ModToInit> Named(params string[] mods) => [.. mods.Select(mod => new ModToInit(mod, [], []))];
}
