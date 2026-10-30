using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests;

/// <summary>A fixture's init of one mod, through the handler over a held copy of the load order.</summary>
internal static class DecompileAndCommitEveryPluginOf
{
    internal static Task<Answer<DecompileAndCommitResult, SelectionRefusal<DecompileAndCommitRefusal>>> ModAsync(
        LoadOrderSnapshot loadOrder, string mod, IPluginAdapter? adapter = null, INotificationPublisher? notifications = null,
        ISourceAdapter? source = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return TestEditService.DecompileAndCommitModHandler(holder, adapter, notifications, source).DecompileAndCommitAsync(ToDecompileAndCommit.In(loadOrder, mod));
    }

    /// <summary>Every reason something of the selection did not init, whole mods and single plugins alike.</summary>
    internal static List<string> RefusalMessages(this Answer<DecompileAndCommitResult, SelectionRefusal<DecompileAndCommitRefusal>> answer) =>
        answer.Holds(out var result, out var whole) ? [.. result.Refused.Select(r => r.Message)] : [whole.Message];

    /// <summary>The answer for a selection of one mod holding one plugin.</summary>
    internal static PluginDecompiledAndCommitted Only(this Answer<DecompileAndCommitResult, SelectionRefusal<DecompileAndCommitRefusal>> answer) =>
        !answer.Holds(out var result, out var whole)
            ? new PluginDecompiledAndCommitted(false, whole.Refusal, whole.Message)
            : result switch
            {
                { Applied: [{ Plugins.Count: 1 }], Refused.Count: 0 } => new PluginDecompiledAndCommitted(true, DecompileAndCommitRefusal.None, ""),
                { Applied.Count: 0, Refused: [var refused] } => new PluginDecompiledAndCommitted(false, refused.Refusal, refused.Message),
                _ => throw new InvalidOperationException(
                    $"Expected one plugin's answer, got {result.Applied.Count} landed and {result.Refused.Count} refused."),
            };
}

internal sealed record PluginDecompiledAndCommitted(bool Applied, DecompileAndCommitRefusal Refusal, string Message);

/// <summary>Mods to init as the extension hands a mod with no file of the mod manager's.</summary>
internal static class ToDecompileAndCommit
{
    /// <summary>Each mod with the source folder the load order's provider names for it, or its own name when none
    /// does.</summary>
    internal static IReadOnlyList<ModToDecompileAndCommit> In(LoadOrderSnapshot? loadOrder, params string[] mods) =>
        [.. mods.Select(mod => new ModToDecompileAndCommit(mod, new NewRepository(SourceFolderOf(loadOrder, mod), [], SourceInits.ManifestOf(mod))))];

    private static string SourceFolderOf(LoadOrderSnapshot? loadOrder, string mod) =>
        loadOrder?.Plugins.Select(plugin => plugin.Provider).OfType<PluginProvider.FromMod>()
            .FirstOrDefault(provider => string.Equals(provider.Name, mod, StringComparison.OrdinalIgnoreCase))?.SourceFolder ?? mod;
}
