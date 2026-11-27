using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Starfield;
using Xunit.Abstractions;

namespace MEditService.TestSupport;

/// <summary>Mutagen's first write and read of each game's plugin cost seconds once per process.</summary>
public class MutagenWarmedTestFramework(IMessageSink messageSink) : GamesRegisteredTestFramework(messageSink)
{
    protected override void Warm()
    {
        using var scratch = new ScratchDirectory("medit-warm-up-");
        var key = ModKey.FromFileName("WarmUp.esp");
        var path = Path.Combine(scratch, key.FileName);

        var fallout4 = new Fallout4Mod(key, Fallout4Release.Fallout4);
        fallout4.Npcs.AddNew("WarmUp");
        fallout4.WriteToBinary(path);
        using (var read = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(key, path), Fallout4Release.Fallout4)) _ = read.Npcs.Count;

        var skyrim = new SkyrimMod(key, SkyrimRelease.SkyrimSE);
        skyrim.Npcs.AddNew("WarmUp");
        skyrim.WriteToBinary(path);
        using (var read = SkyrimMod.CreateFromBinaryOverlay(new ModPath(key, path), SkyrimRelease.SkyrimSE)) _ = read.Npcs.Count;

        var starfield = new StarfieldMod(key, StarfieldRelease.Starfield);
        starfield.Npcs.AddNew("WarmUp");
        starfield.WriteToBinary(path);
        using (var read = StarfieldMod.CreateFromBinaryOverlay(new ModPath(key, path), StarfieldRelease.Starfield)) _ = read.Npcs.Count;
    }
}
