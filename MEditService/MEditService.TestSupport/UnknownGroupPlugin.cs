using System.Buffers.Binary;
using System.Text;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>A plugin with one NPC and, after it, a top-level group no game defines holding a MISC record,
/// which Mutagen drops on read.</summary>
public static class UnknownGroupPlugin
{
    private const int HeaderLength = 24;

    public static void Write(string path, FormKey npc, FormKey droppedMisc)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(path)), Fallout4Release.Fallout4);
        mod.Npcs.Add(new Npc(npc, Fallout4Release.Fallout4) { EditorID = "Guy" });
        mod.WriteToBinary(path);

        var record = new byte[HeaderLength];
        Encoding.ASCII.GetBytes("MISC").CopyTo(record, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(12), droppedMisc.ID);

        var group = new byte[HeaderLength];
        Encoding.ASCII.GetBytes("GRUP").CopyTo(group, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(group.AsSpan(4), (uint)(HeaderLength + record.Length));
        Encoding.ASCII.GetBytes("ZZZZ").CopyTo(group, 8);

        using var file = File.Open(path, FileMode.Append);
        file.Write(group);
        file.Write(record);
    }
}
