using System.Collections.Concurrent;
using System.Drawing;
using System.Reflection;
using System.Reflection.Emit;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Binary.Translations;

namespace MEditService.Codec.Schema;

/// <summary>Whether a colour member's binary form holds an alpha: the <see cref="ColorBinaryType"/>
/// Mutagen's generated binary overlay reads the member with, a constant in its getter's IL and in no
/// metadata reflection reads.</summary>
internal sealed class HeldAlpha(ILogger logger)
{
    internal const string WarningPrefix = "SchemaReflector: a colour's alpha unavailable";

    private const string OverlaySuffix = "BinaryOverlay";

    private readonly ConcurrentDictionary<PropertyInfo, bool> _held = new();

    /// <summary>A member whose overlay names no binary type, and an array element, which has no member
    /// to ask, read as holding one, so a cell shows every component the document carries rather than
    /// hiding one.</summary>
    internal bool By(PropertyInfo? prop)
    {
        if (prop != null) return _held.GetOrAdd(prop, Ask);
        logger.LogWarning("{Prefix}: an array element has no member whose overlay names its binary type", WarningPrefix);
        return true;
    }

    private bool Ask(PropertyInfo prop)
    {
        if (OverlayGetter(prop) is { } getter && BinaryTypeReadIn(getter) is { } binaryType)
            return binaryType is ColorBinaryType.Alpha or ColorBinaryType.AlphaFloat;
        logger.LogWarning("{Prefix}: no binary overlay of {Owner} names the binary type of {Member}", WarningPrefix, prop.DeclaringType?.FullName, prop.Name);
        return true;
    }

    private static MethodInfo? OverlayGetter(PropertyInfo prop)
    {
        if (ReflectedTypes.GetSetterType(ReflectedTypes.DeclaringTypeOf(prop)) is not { } setter) return null;
        return new[] { setter, LoquiUnions.ConcreteUnder(setter) }
            .OfType<Type>()
            .Select(owner => owner.Assembly.GetType(owner.FullName + OverlaySuffix))
            .OfType<Type>()
            .Select(overlay => overlay.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(p => p.Name == prop.Name && (Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType) == typeof(Color))?.GetMethod)
            .FirstOrDefault(getter => getter != null);
    }

    private static ColorBinaryType? BinaryTypeReadIn(MethodInfo getter)
    {
        if (getter.GetMethodBody()?.GetILAsByteArray() is not { } il) return null;
        int? pushed = null;
        var at = 0;
        while (at < il.Length)
        {
            var code = il[at] == 0xFE ? TwoByte[il[at + 1]] : OneByte[il[at]];
            if (code.Size == 0) return null;
            var operand = at + code.Size;
            if ((code == OpCodes.Call || code == OpCodes.Callvirt) && pushed is { } value && TakesBinaryType(getter, BitConverter.ToInt32(il, operand)))
                return (ColorBinaryType)value;
            pushed = Pushed(code, il, operand);
            at = operand + OperandSize(code, il, operand);
        }
        return null;
    }

    private static bool TakesBinaryType(MethodInfo getter, int token)
    {
        try
        {
            return getter.Module.ResolveMethod(token, getter.DeclaringType?.GetGenericArguments(), null)?.GetParameters() is [.., var last]
                && last.ParameterType == typeof(ColorBinaryType);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static int? Pushed(OpCode code, byte[] il, int operand) =>
        code.Value switch
        {
            var v when v >= OpCodes.Ldc_I4_0.Value && v <= OpCodes.Ldc_I4_8.Value => v - OpCodes.Ldc_I4_0.Value,
            var v when v == OpCodes.Ldc_I4_S.Value => (sbyte)il[operand],
            var v when v == OpCodes.Ldc_I4.Value => BitConverter.ToInt32(il, operand),
            _ => null,
        };

    private static int OperandSize(OpCode code, byte[] il, int operand) =>
        code.OperandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + (4 * BitConverter.ToInt32(il, operand)),
            _ => 4,
        };

    private static readonly OpCode[] OneByte = OpCodeTable(size: 1);
    private static readonly OpCode[] TwoByte = OpCodeTable(size: 2);

    private static OpCode[] OpCodeTable(int size)
    {
        var table = new OpCode[256];
        foreach (var code in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Select(f => f.GetValue(null)).OfType<OpCode>().Where(c => c.Size == size))
        {
            table[(ushort)code.Value & 0xFF] = code;
        }
        return table;
    }
}
