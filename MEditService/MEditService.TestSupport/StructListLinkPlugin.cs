using System.Text;

namespace MEditService.TestSupport;

/// <summary>A quest whose script holds a struct-list property whose only link to its master sits inside a struct, which Mutagen's EnumerateFormLinks skips (Mutagen #688).</summary>
public static class StructListLinkPlugin
{
    private const string FileName = "Harbor Dispatch.esp";
    public const string Master = "Harbor Core.esm";
    public const string QuestEditorId = "HarborDispatchQuest";
    public const string ScriptName = "Harbor:DispatchScript";
    public const string PropertyName = "Routes";
    private const string LinkMemberName = "Destination";
    public const uint LinkedMasterFormId = 0x00000A01;
    private const uint QuestFormId = 0x01000800;

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
        RawPlugin.U16(6), RawPlugin.U16(ObjectFormat), RawPlugin.U16(1),
        WString(ScriptName), [0], RawPlugin.U16(1),
        WString(PropertyName), [StructListType, EditedFlag],
        RawPlugin.U32(1), RawPlugin.U32(1),
        WString(LinkMemberName), [ObjectType, EditedFlag], RawPlugin.U16(0), RawPlugin.U16(NoAlias), RawPlugin.U32(LinkedMasterFormId));

    private static byte[] WString(string value) => RawPlugin.Concat(RawPlugin.U16((ushort)value.Length), Encoding.ASCII.GetBytes(value));
}
