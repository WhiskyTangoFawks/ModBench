using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>A plugin file the load order names that could not be read, and what went wrong with
/// it.</summary>
public readonly record struct UnreadablePlugin(string FileName, string Reason);

/// <summary>What a link cache over the load order's files answers: the record each FormKey asked
/// about names, and the files nothing could be read from (ADR-0019).</summary>
public sealed record LinkAnswers(
    IReadOnlyDictionary<string, ResolvedFormKey> Targets,
    IReadOnlyList<UnreadablePlugin> UnreadableFiles)
{
    public static readonly LinkAnswers None =
        new(new Dictionary<string, ResolvedFormKey>(StringComparer.OrdinalIgnoreCase), []);
}

/// <summary>One link cache over a whole load order, asked a set of FormKeys and answering names
/// (ADR-0005 rule 2): the cache and the records it holds never leave this file.</summary>
internal static class LoadOrderLinks
{
    internal static LinkAnswers Targets(
        IPluginAdapter adapter,
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys)
    {
        if (loadOrder.Count == 0 || formKeys.Count == 0) return LinkAnswers.None;

        var opened = new List<ILoadedMod>(loadOrder.Count);
        var unreadable = new List<UnreadablePlugin>();
        try
        {
            foreach (var modPath in loadOrder)
            {
                // A file the load order names can be malformed or gone by now (ADR-0003). It answers
                // nothing, which is a fact about the file rather than about the links into it.
                try { opened.Add(adapter.OpenForRead(modPath, gameRelease)); }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    unreadable.Add(new UnreadablePlugin(modPath.ModKey.FileName.String, Why(ex)));
                }
            }
            return new LinkAnswers(Named(opened, schemas, formKeys), unreadable);
        }
        finally
        {
            foreach (var mod in opened) mod.Dispose();
        }
    }

    // Mutagen reaches a game's mod type through a reflective activator, so the failure worth
    // repeating — the file that is not there, the header that is not a header — is the innermost one.
    private static string Why(Exception ex) => ex.GetBaseException().Message;

    private static Dictionary<string, ResolvedFormKey> Named(
        List<ILoadedMod> opened,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys)
    {
        var targets = new Dictionary<string, ResolvedFormKey>(StringComparer.OrdinalIgnoreCase);
        if (opened.Count == 0) return targets;

        using var cache = opened.Select(mod => mod.Getter).ToUntypedImmutableLinkCache();
        foreach (var formKey in formKeys)
        {
            // A malformed FormKey is an editor's raw input: it names nothing and throws nothing.
            if (!FormKey.TryFactory(formKey, out var parsed)) continue;
            if (!cache.TryResolve<IMajorRecordGetter>(parsed, out var record)) continue;
            targets[formKey] = new ResolvedFormKey(RecordTableName.Of(record, schemas), record.EditorID);
        }
        return targets;
    }
}
