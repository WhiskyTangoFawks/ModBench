using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>ADR-0007's compile, for one plugin.</summary>
internal sealed class PluginCompileService(
    LoadOrderHolder loadOrderHolder,
    SchemaReflector schemaReflector,
    IPluginAdapter adapter,
    ISourceAdapter source,
    ILogger<PluginCompileService> logger)
{
    private readonly TreeCompile _compile = new(schemaReflector, adapter, logger);

    public async Task<PluginCompileOutcome> CompileAsync(PluginAddress plugin) =>
        loadOrderHolder.Current.Plugin(plugin) is { } registered
            ? await CompileAsync(registered)
            : PluginCompileOutcome.Refused(CompileRefusal.PluginNotInLoadOrder, $"{plugin.Name} is not in the load order.");

    /// <summary>The plugin compiled to its path, which the load order need not hold yet, as a fresh clone's build's does
    /// not (source.md, Build, story 7). A strings file <paramref name="leavesUnwritten"/> names is left.</summary>
    public async Task<PluginCompileOutcome> CompileAsync(RegisteredPlugin registered, Func<string, bool>? leavesUnwritten = null)
    {
        var plugin = registered.Key;
        var loadOrder = loadOrderHolder.Current;
        if (registered.Provider is not PluginProvider.FromMod mod || !source.IsSourceMod(registered))
            return PluginCompileOutcome.Refused(CompileRefusal.PluginNotCompiledPlugin, $"{plugin.Name} is not a compiled plugin, so there is no source to compile.");

        if (source.WhySourceDoesNotRead(registered) is { } why)
        {
            return PluginCompileOutcome.Refused(
                why.DecompileRepairs ? CompileRefusal.SourceRegenerable : CompileRefusal.PluginSourceUnreadable,
                $"{plugin.Name}'s plugin source is unreadable, so it cannot be compiled: {why.Reason}");
        }

        // One repository for the whole pass, so the tree it answers from is read once.
        var repository = source.OverFolder(mod, loadOrder.GameRelease);
        if (!repository.TreeOf(plugin).Holds(out var tree, out var unread)) return TreeCompile.SourceDoesNotParse(plugin, unread);

        // A document the read could not open is content this compile does not have, and compiling the
        // rest would write a binary missing that record with nothing left to notice it
        // (ADR-0019).
        if (tree.Unreadable is { } unreadable)
        {
            return PluginCompileOutcome.Refused(
                CompileRefusal.SourceFileHeld,
                $"{plugin.Name} could not be read from its source: {unreadable} could not be opened. " +
                "Another program may be holding it; close it and compile again.");
        }

        if (tree.Files.Count == 0)
        {
            return PluginCompileOutcome.Refused(
                CompileRefusal.SourceRegenerable,
                $"{plugin.Name}'s source folder holds no files, so there is nothing to compile.");
        }

        return await _compile.CompileAsync(registered, tree, loadOrder, save =>
            repository.WriteBinary(plugin, save.BinarySha256(), () => save.Commit(leavesUnwritten ?? (_ => false))).Holds(out var recorded, out var unwritten)
                ? recorded
                : TreeCompile.WriteFailed(plugin, unwritten.Reason));
    }
}
