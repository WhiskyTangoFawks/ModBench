using System.Collections.Concurrent;
using System.Security.Cryptography;
using MEditService.Commands.Edits;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Track is the slow step of a tracked fixture, and the mod folder it leaves names no
/// absolute path, so each distinct mod folder is tracked once per run and copied into every test's
/// own.</summary>
internal static class TrackedTemplates
{
    private static readonly ConcurrentDictionary<string, Lazy<ScratchDirectory>> Folders = new(StringComparer.Ordinal);

    static TrackedTemplates() =>
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            foreach (var folder in Folders.Values.Where(folder => folder.IsValueCreated))
                folder.Value.Dispose();
        };

    /// <summary>Fills <paramref name="modFolder"/> as <paramref name="make"/> fills an empty mod
    /// folder. <paramref name="key"/> names everything <paramref name="make"/> writes, which runs
    /// once per key.</summary>
    internal static void CopyInto(string modFolder, string key, Action<string> make)
    {
        var template = Folders.GetOrAdd(key, _ => new Lazy<ScratchDirectory>(() =>
        {
            var folder = new ScratchDirectory("medit-tracked-template-");
            make(folder.Path);
            return folder;
        })).Value;
        CopyDirectory(template.Path, modFolder);
    }

    /// <summary><paramref name="mod"/>, which has no masters, written into
    /// <paramref name="modFolder"/> and tracked there. Keyed on its bytes, so fixtures share a
    /// template only when their plugins are one.</summary>
    internal static void WriteTracked(string modFolder, IModGetter mod)
    {
        using var binary = new MemoryStream();
        mod.WriteToBinary(binary);
        var bytes = binary.ToArray();
        var pluginName = mod.ModKey.FileName.String;
        CopyInto(modFolder, $"{pluginName} {Convert.ToHexString(SHA256.HashData(bytes))}", template =>
        {
            File.WriteAllBytes(Path.Combine(template, pluginName), bytes);
            TrackAlone(template, pluginName);
        });
    }

    /// <summary>Tracks the one plugin <paramref name="modFolder"/> holds, in a load order of that
    /// plugin alone.</summary>
    internal static void TrackAlone(string modFolder, string pluginName, SourcePreset preset = SourcePreset.Edits)
    {
        const string origin = "TemplateMod";
        using var gameDirectory = new ScratchDirectory("medit-tracked-template-game-");
        var loadOrder = SnapshotPlugins.Snapshot(gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            [new LoadOrderEntry(pluginName, Path.Combine(modFolder, pluginName), origin, Slot: 0, Enabled: true, Winning: true)]);
        var result = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(loadOrder, origin, preset)
            .GetAwaiter().GetResult();
        if (result.Landed.Count != 1)
            throw new InvalidOperationException($"Expected {pluginName} to track: {string.Join("; ", result.Refused.Select(r => r.Message))}");
    }

    internal static void CopyDirectory(string sourceFolder, string destinationFolder)
    {
        foreach (var directory in Directory.EnumerateDirectories(sourceFolder, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destinationFolder, Path.GetRelativePath(sourceFolder, directory)));

        foreach (var file in Directory.EnumerateFiles(sourceFolder, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(destinationFolder, Path.GetRelativePath(sourceFolder, file)));
    }
}
