using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;

namespace BethesdaPluginService.Core.Loading;

public class PluginLoader : IPluginLoader
{
    public IReadOnlyList<PluginMetadata> LoadPlugins(string dataFolderPath, string pluginsTxtPath)
    {
        var listings = PluginListings.RawLoadOrderListingsFromPath(pluginsTxtPath, GameRelease.Fallout4)
            .Where(l => l.Enabled)
            .ToList();

        var results = new List<PluginMetadata>(listings.Count);

        for (int i = 0; i < listings.Count; i++)
        {
            var listing = listings[i];
            var filePath = Path.Combine(dataFolderPath, listing.FileName);
            if (!File.Exists(filePath))
                continue;

            var modKey = ModKey.FromFileName(listing.FileName);
            var modPath = new ModPath(modKey, filePath);
            using var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);

            var masters = mod.ModHeader.MasterReferences
                .Select(r => r.Master.FileName.ToString())
                .ToList();

            results.Add(new PluginMetadata(
                Name: listing.FileName,
                Path: filePath,
                LoadOrderIndex: i,
                IsLight: listing.FileName.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
                IsMaster: listing.FileName.EndsWith(".esm", StringComparison.OrdinalIgnoreCase),
                Masters: masters,
                RecordCount: mod.EnumerateMajorRecords().Count()
            ));
        }

        return results;
    }
}
