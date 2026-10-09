using System.Collections.Concurrent;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>The layout's folder for each record type: a record sits in the folder its group is named,
/// and a cell or worldspace has a directory of its own there rather than a file.</summary>
internal sealed class GroupFolders
{
    private static readonly ConcurrentDictionary<GameRelease, GroupFolders> ByRelease = new();

    private readonly RecordTypes _types;

    // Named, not inferred from the door: inference would cover a third type the day Mutagen's generator
    // picks a directory for one. A quest is flat: every child slot is embedded.
    private readonly HashSet<string> _directoryPerRecord;

    private GroupFolders(RecordTypes types)
    {
        _types = types;
        _directoryPerRecord = new HashSet<string>(StringComparer.Ordinal)
        {
            GroupOf(types, types.Cell),
            GroupOf(types, types.Worldspace),
        };
    }

    internal static GroupFolders For(GameRelease release) =>
        ByRelease.GetOrAdd(release, game => new GroupFolders(RecordTypes.For(game)));

    /// <summary>The folder a record's own file sits in. Null for a cell or worldspace, which has a
    /// directory, and for a type with no group of its own.</summary>
    internal string? FlatFolderOf(string recordType) =>
        _types.IsCell(recordType) || _types.IsWorldspace(recordType) ? null : _types.GroupOf(recordType);

    /// <summary>A search hint, never a path: which folder a record is somewhere inside. A wrong answer
    /// costs a miss, never a wrong write.</summary>
    internal string? FolderOf(string recordType) => _types.GroupOf(recordType);

    /// <summary>The folders whose records get a directory rather than a file. Every such record's
    /// directory sits somewhere under one of them, so a scan of all of them finds it without being
    /// told which.</summary>
    internal IReadOnlySet<string> DirectoryPerRecordFolders => _directoryPerRecord;

    /// <summary>The record type of a directory in <paramref name="folder"/>, and a cell when
    /// <paramref name="nested"/>: only a cell's directory sits below block levels. Null for any other
    /// folder.</summary>
    internal string? DirectoryPerRecordTypeIn(string folder, bool nested)
    {
        if (!_directoryPerRecord.Contains(folder)) return null;
        return nested ? _types.Cell : _types.OnlyRecordTypeIn(folder);
    }

    /// <summary>The record type of a file in <paramref name="folder"/>. Null when its group holds
    /// several (Globals), so the document names its own type, and for a folder no file's record sits in.</summary>
    internal string? RecordTypeIn(string folder) =>
        _directoryPerRecord.Contains(folder) ? null : _types.OnlyRecordTypeIn(folder);

    private static string GroupOf(RecordTypes types, string recordType) =>
        types.GroupOf(recordType)
        ?? throw new InvalidOperationException($"'{recordType}' sits in no group of the game's mod, and the layout gives it a folder.");
}
