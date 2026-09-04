using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>Two mod folders and one load order, since a copy across plugins is unaskable of one.
/// <see cref="SourcePlugin"/> defaults untracked: the primary scenario copies out of a
/// Data-directory master, whose indexed body is its only representation.</summary>
public sealed class CopyFixture : IDisposable
{
    public const string SourcePluginName = "Source.esm";
    public const string SourceOrigin = "SourceMod";
    public const string DestinationPluginName = "Destination.esp";
    public const string DestinationOrigin = "DestinationMod";

    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string GameDirectory { get; }
    public LoadOrderMirror Mirror { get; }
    public PluginKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);

    public const string SourceNpcEditorId = "SourceNpc";
    public FormKey SourceNpc { get; }

    // Related to itself: the self-reference-follows-the-duplicate proof needs a FormLink that can
    // validly target its own record type.
    public const string SelfLinkingFactionEditorId = "SelfLinkingFaction";
    public FormKey SelfLinkingFaction { get; }

    public const string DestinationNpcEditorId = "DestinationNpc";
    public FormKey DestinationNpc { get; }

    private CopyFixture(bool trackSource)
    {
        SourceModFolder = Directory.CreateTempSubdirectory("medit-copy-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-copy-dest-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-copy-game-").FullName;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var npc = sourceMod.Npcs.AddNew(SourceNpcEditorId);
        var faction = sourceMod.Factions.AddNew(SelfLinkingFactionEditorId);
        var relation = new Relation();
        relation.Target.SetTo(faction);
        faction.Relations.Add(relation);
        sourceMod.WriteToBinary(sourcePath);
        (SourceNpc, SelfLinkingFaction) = (npc.FormKey, faction.FormKey);

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        destinationMod.WriteToBinary(destinationPath);
        DestinationNpc = destinationNpc.FormKey;

        Mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)Mirror).Reconcile(
            GameDirectory,
            [
                new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: 1, Enabled: true, Winning: true),
            ],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Mirror.LoadOrder!, DestinationOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
        if (trackSource)
        {
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, SourceOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
        }
    }

    public static CopyFixture Create(bool trackSource = false) => new(trackSource);

    // Resolved through SourceUnitResolver, matching TwoModFixture's own reason — For needs
    // an order index this fixture has no reason to track.
    public string SourceFileFor(PluginKey plugin, FormKey formKey, string recordType, string? editorId) =>
        SourceUnitResolver.FlatSourcePath(
            plugin.Origin == SourceOrigin ? SourceModFolder : DestinationModFolder,
            plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    public void Dispose()
    {
        Mirror.Dispose();
        TryDelete(SourceModFolder);
        TryDelete(DestinationModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
