using System.Collections.Concurrent;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>The layout's folder for each record type: a record sits in the folder its group is named,
/// and a container has a directory of its own there rather than a file.</summary>
internal sealed class GroupFolders
{
    private static readonly ConcurrentDictionary<GameRelease, GroupFolders> ByRelease = new();

    private readonly RecordTypes _types;

    // Not inferred from the door, which would cover another type the day Mutagen's generator picks a
    // directory for one.
    private readonly HashSet<string> _directoryPerRecord;

    private GroupFolders(RecordTypes types)
    {
        _types = types;
        _directoryPerRecord = new HashSet<string>(types.Creatable.Where(HasDirectory).Select(type => GroupOf(types, type)), StringComparer.Ordinal);
    }

    internal static GroupFolders For(GameRelease release) =>
        ByRelease.GetOrAdd(release, game => new GroupFolders(RecordTypes.For(game)));

    /// <summary>The folder a record's own file sits in. Null for a cell or worldspace, which has a
    /// directory, and for a type with no group of its own.</summary>
    internal string? FlatFolderOf(string recordType) =>
        _types.GroupOf(recordType) is { } group && !_directoryPerRecord.Contains(group) ? group : null;

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

    /// <summary>Whether a record of <paramref name="recordType"/> has a directory rather than a file: a cell and a
    /// worldspace for their blocks, any other for the children it files.</summary>
    internal bool HasDirectory(string recordType) =>
        _types.IsCell(recordType) || _types.IsWorldspace(recordType) || _types.HoldsChildFiles(recordType);

    /// <summary>Whether the records in <paramref name="folder"/> hold children in files of their own.</summary>
    internal bool HoldsChildFiles(string folder) =>
        _types.HoldsChildFiles(_types.OnlyRecordTypeIn(folder));

    /// <summary>The record type of a document <paramref name="directories"/> below a folder whose records
    /// hold child files, walked down through slot folders, and whether it sits in its record's directory.
    /// Null for any other folder or path.</summary>
    internal (string RecordType, bool InItsDirectory)? HeldTypeAt(string folder, IReadOnlyList<string> directories)
    {
        if (!HoldsChildFiles(folder) || _types.OnlyRecordTypeIn(folder) is not { } type || directories.Count == 0) return null;

        for (var slot = 1; slot < directories.Count; slot += 2)
        {
            if (_types.FileSlotRecordType(type, directories[slot]) is not { } held) return null;
            type = held;
            if (slot + 1 == directories.Count) return (type, InItsDirectory: false);
            if (!HasDirectory(type)) return null;
        }
        return (type, InItsDirectory: true);
    }

    private static string GroupOf(RecordTypes types, string recordType) =>
        types.GroupOf(recordType)
        ?? throw new InvalidOperationException($"'{recordType}' sits in no group of the game's mod, and the layout gives it a folder.");
}
