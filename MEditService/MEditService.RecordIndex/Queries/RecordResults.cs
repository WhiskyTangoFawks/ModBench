using System.Security.Cryptography;
using System.Text.Json;
using MEditService.LoadOrder;

namespace MEditService.RecordIndex.Queries;

/// <summary>Gives each record of an answer a result id, and leaves a record the caller holds the result of out of the answer's rows.</summary>
internal static class RecordResults
{
    public static HashSet<string>? KeysOf(RecordsAsked? asked) =>
        asked?.Keys is { } keys ? new HashSet<string>(keys, StringComparer.OrdinalIgnoreCase) : null;

    public static PluginProblems Of(PluginProblems answer, RecordsAsked? asked)
    {
        var byRecord = answer.Problems
            .GroupBy(problem => problem.FormKey ?? "", StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.OrdinalIgnoreCase);
        foreach (var key in asked?.Keys is null ? [] : asked.Keys.Append("")) byRecord.TryAdd(key, []);
        var records = Results(answer.Plugin, answer.Failure is not null, byRecord.Select(record => (record.Key, (object)record.Value, (IReadOnlyList<string>)[])), asked);
        var left = Left(records);
        return answer with { Problems = [.. answer.Problems.Where(problem => !left.Contains(problem.FormKey ?? ""))], Records = records };
    }

    public static PluginFilePaths Of(PluginFilePaths answer, IReadOnlyDictionary<string, List<string>> unreadOf, RecordsAsked? asked)
    {
        var paths = answer.Paths.ToLookup(path => path.FormKey, StringComparer.OrdinalIgnoreCase);
        var scripts = answer.Scripts.ToLookup(script => script.FormKey, StringComparer.OrdinalIgnoreCase);
        var keys = paths.Select(group => group.Key).Concat(scripts.Select(group => group.Key)).Concat(unreadOf.Keys).Concat(asked?.Keys ?? [])
            .Distinct(StringComparer.OrdinalIgnoreCase);
        var records = Results(
            answer.Plugin, answer.Failure is not null,
            keys.Select(key => (key, (object)new RecordPaths(paths[key].ToList(), scripts[key].ToList(), unreadOf.GetValueOrDefault(key) ?? []), (IReadOnlyList<string>)(unreadOf.GetValueOrDefault(key) ?? []))), asked);
        var left = Left(records);
        var leftUnread = records.Where(record => record.Unchanged).SelectMany(record => unreadOf.GetValueOrDefault(record.FormKey) ?? []).ToHashSet();
        return answer with
        {
            Paths = [.. answer.Paths.Where(path => !left.Contains(path.FormKey))],
            Scripts = [.. answer.Scripts.Where(script => !left.Contains(script.FormKey))],
            Unread = [.. answer.Unread.Where(line => !leftUnread.Contains(line))],
            Records = [.. records.Select(record => record.Unchanged ? record with { Unread = [] } : record)],
        };
    }

    private sealed record RecordPaths(List<NamedFilePath> Paths, List<NamedScript> Scripts, List<string> Unread);

    private static HashSet<string> Left(List<RecordResult> records) =>
        records.Where(record => record.Unchanged).Select(record => record.FormKey).ToHashSet(StringComparer.OrdinalIgnoreCase);

    // A failed answer is whole: the caller asks the whole plugin again, so nothing of it is left out.
    private static List<RecordResult> Results(
        PluginAddress plugin, bool failed, IEnumerable<(string FormKey, object Content, IReadOnlyList<string> Unread)> records, RecordsAsked? asked)
    {
        var held = failed
            ? new Dictionary<string, string>()
            : (asked?.Known ?? []).Where(known => PluginAddress.Comparer.Equals(known.Plugin, plugin))
                .ToDictionary(known => known.FormKey, known => known.ResultId, StringComparer.OrdinalIgnoreCase);
        return [.. records.Select(record =>
        {
            var id = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(record.Content)));
            return new RecordResult(record.FormKey, id, held.TryGetValue(record.FormKey, out var known) && known == id, record.Unread);
        })];
    }
}
