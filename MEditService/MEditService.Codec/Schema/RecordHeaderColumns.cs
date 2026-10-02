using System.Globalization;
using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>A major record type's header members as columns, in the annotation table's order: each
/// row whose interface the type carries and declares the member on.</summary>
internal static class RecordHeaderColumns
{
    private const string FlagsMember = RecordHeaderFlags.Member;

    // Every bit, so each flag view Mutagen spells over the raw integer shows up.
    private const long AllBits = -1;

    internal static List<ColumnSpec> For(
        Type getterType, ILookup<string, PropertyInfo> declarations, GameReflection game, ILogger logger)
    {
        var columns = new List<ColumnSpec>();
        foreach (var (typeName, member, label, ignoredInConflicts, isVersionControlInfo1) in game.Annotations.RecordHeaderMembers)
        {
            var declared = declarations[member].ToList();
            if (!declared.Exists(p => ReflectedTypes.DeclaringTypeOf(p).Name == typeName)) continue;
            var prop = ReflectedTypes.MostDerived(declared);
            if (ColumnReflection.BuildColumn(prop, prop.Name, game, logger) is not { } column) continue;

            var header = column with
            {
                Field = column.Field with
                {
                    DisplayLabel = label,
                    IsRecordHeaderMember = true,
                    IsRecordFormKey = ReflectedTypes.IsFormKey(prop.PropertyType),
                    IgnoredInConflicts = ignoredInConflicts,
                    IsVersionControlInfo1 = isVersionControlInfo1,
                },
            };
            columns.Add(member == FlagsMember ? WithFlagViews(header, getterType, declarations, game) : header);
        }
        return columns;
    }

    // Record Flags names the bits of every flag view Mutagen spells over the raw integer, and those
    // views are its aliases.
    private static ColumnSpec WithFlagViews(
        ColumnSpec flags, Type getterType, ILookup<string, PropertyInfo> declarations, GameReflection game)
    {
        var aliases = game.Defaults.MembersAliasing(getterType, FlagsMember, AllBits);
        var names = BitNames(aliases, declarations, getterType, game);
        return flags with { Field = flags.Field with { EnumMembers = names }, Aliases = aliases };
    }

    // A bit two views name takes the name of the view declared on the narrower type, and otherwise
    // of the view first by member name. A bit no view names takes its annotation row's name.
    private static List<EnumMember> BitNames(
        IReadOnlyList<string> aliases, ILookup<string, PropertyInfo> declarations, Type getterType, GameReflection game)
    {
        var byBit = new SortedDictionary<long, (EnumMember Member, Type Declaring)>();
        var views = aliases.Where(declarations.Contains).Order(StringComparer.Ordinal)
            .Select(a => ReflectedTypes.MostDerived(declarations[a]));
        foreach (var view in views)
        {
            var core = ReflectedTypes.CoreOf(view).Core;
            if (!core.IsEnum || core.GetCustomAttribute<FlagsAttribute>() == null) continue;
            var declaring = ReflectedTypes.DeclaringTypeOf(view);
            foreach (var (bit, member) in Bits(core))
            {
                if (!byBit.TryGetValue(bit, out var held) || (held.Declaring != declaring && held.Declaring.IsAssignableFrom(declaring)))
                    byBit[bit] = (member, declaring);
            }
        }
        foreach (var (bit, member) in AgreedBits(game.Annotations.RecordFlagEnumsFor(getterType)))
            byBit[bit] = (member, getterType);
        foreach (var (bit, name) in game.Annotations.RecordFlagNamesFor(getterType))
        {
            if (!byBit.TryAdd(bit, (new EnumMember(name, bit.ToString(CultureInfo.InvariantCulture)), getterType))) continue;
            game.Observed.NamedFlag(getterType.Name, bit);
        }
        return [.. byBit.Values.Select(v => v.Member)];
    }

    private static IEnumerable<(long Bit, EnumMember Member)> Bits(Type flagsEnum)
    {
        foreach (var member in LeafClassification.GetEnumMembers(flagsEnum))
        {
            if (member.BitValue is { } bit) yield return (long.Parse(bit, CultureInfo.InvariantCulture), member);
        }
    }

    // Each of several enums is one base record type's, so a bit's name holds for every record of
    // the type only where all of them give it.
    private static IEnumerable<(long Bit, EnumMember Member)> AgreedBits(IReadOnlyList<Type> enums)
    {
        var alternatives = enums.Select(e => Bits(e).ToList()).ToList();
        return alternatives.Count == 0 ? [] : alternatives[0].Where(b => alternatives.TrueForAll(a => a.Contains(b)));
    }
}
