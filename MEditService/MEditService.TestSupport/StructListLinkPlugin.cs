using System.Buffers.Binary;
using System.Text;

namespace MEditService.TestSupport;

/// <summary>A quest whose script holds a struct-list property whose only link to its master sits inside a struct, which Mutagen's EnumerateFormLinks skips (Mutagen #688).</summary>
public static class StructListLinkPlugin
{
    public const string FileName = "Harbor Dispatch.esp";
    public const string Master = "Harbor Core.esm";
    public const string QuestEditorId = "HarborDispatchQuest";
    public const string ScriptName = "Harbor:DispatchScript";
    public const string PropertyName = "Routes";
    public const string LinkMemberName = "Destination";
    public const uint LinkedMasterFormId = 0x00000A01;
    public const uint QuestFormId = 0x01000800;

    private const ushort ObjectFormat = 2;
    private const byte ObjectType = 1;
    private const byte StructListType = 17;
    private const byte EditedFlag = 1;
    private const ushort NoAlias = 0xFFFF;

    public static GeneratedPlugin Plugin => new(FileName,
        RawPlugin.Plugin(RawPlugin.Tes4(0x801, 1, false, Master),
            RawPlugin.Group("QUST",
                RawPlugin.Record("QUST", QuestFormId,
                    RawPlugin.EditorId(QuestEditorId),
                    RawPlugin.Subrecord("VMAD", Vmad())))));

    private static byte[] Vmad() => RawPlugin.Concat(
        U16(6), U16(ObjectFormat), U16(1),
        WString(ScriptName), [0], U16(1),
        WString(PropertyName), [StructListType, EditedFlag],
        U32(1), U32(1),
        WString(LinkMemberName), [ObjectType, EditedFlag], U16(0), U16(NoAlias), U32(LinkedMasterFormId));

    private static byte[] U16(ushort value)
    {
        var bytes = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(bytes, value);
        return bytes;
    }

    private static byte[] U32(uint value)
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, value);
        return bytes;
    }

    private static byte[] WString(string value) => RawPlugin.Concat(U16((ushort)value.Length), Encoding.ASCII.GetBytes(value));
}
