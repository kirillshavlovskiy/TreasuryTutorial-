'use client';

import * as React from 'react';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
} from 'react-day-picker';

import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  buttonVariant = 'ghost',
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>['variant'];
}) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        'group/calendar w-max shrink-0 bg-slate-900 p-3 [--cell-size:2.75rem] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent',
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className,
      )}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: date =>
          date.toLocaleString('default', { month: 'short' }),
        ...formatters,
      }}
      classNames={{
        root: cn(
          defaultClassNames.root,
          'w-max min-w-[calc(var(--cell-size)*7)] shrink-0',
        ),
        months: cn(
          defaultClassNames.months,
          'relative flex w-max flex-col gap-4 md:flex-row',
        ),
        month: cn(defaultClassNames.month, 'flex w-max flex-col gap-4'),
        nav: cn(
          'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
          defaultClassNames.nav,
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          'size-[var(--cell-size)] select-none p-0 text-slate-300 aria-disabled:opacity-50',
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          'size-[var(--cell-size)] select-none p-0 text-slate-300 aria-disabled:opacity-50',
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          'flex h-[var(--cell-size)] w-full items-center justify-center px-[var(--cell-size)]',
          defaultClassNames.month_caption,
        ),
        dropdowns: cn(
          'flex h-[var(--cell-size)] w-full items-center justify-center gap-1.5 text-sm font-medium text-slate-200',
          defaultClassNames.dropdowns,
        ),
        dropdown_root: cn(
          'relative rounded-md border border-slate-700 shadow-sm has-focus:border-sky-500 has-focus:ring-[3px] has-focus:ring-sky-500/40',
          defaultClassNames.dropdown_root,
        ),
        dropdown: cn(
          'absolute inset-0 bg-slate-900 opacity-0',
          defaultClassNames.dropdown,
        ),
        caption_label: cn(
          'select-none font-medium text-slate-200',
          captionLayout === 'label'
            ? 'text-sm'
            : 'flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:size-3.5 [&>svg]:text-slate-500',
          defaultClassNames.caption_label,
        ),
        month_grid: cn(defaultClassNames.month_grid, 'w-max border-collapse'),
        weekdays: cn(defaultClassNames.weekdays, 'flex w-max'),
        weekday: cn(
          defaultClassNames.weekday,
          'flex-none select-none rounded-md text-[0.8rem] font-normal text-slate-500',
          'h-[var(--cell-size)] w-[var(--cell-size)]',
        ),
        week: cn(defaultClassNames.week, 'mt-2 flex w-max'),
        week_number_header: cn(
          'w-[var(--cell-size)] select-none',
          defaultClassNames.week_number_header,
        ),
        week_number: cn(
          'select-none text-[0.8rem] text-slate-500',
          defaultClassNames.week_number,
        ),
        day: cn(
          defaultClassNames.day,
          'group/day relative flex-none select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md',
          'h-[var(--cell-size)] w-[var(--cell-size)]',
        ),
        range_start: cn('rounded-l-md bg-slate-800', defaultClassNames.range_start),
        range_middle: cn('rounded-none', defaultClassNames.range_middle),
        range_end: cn('rounded-r-md bg-slate-800', defaultClassNames.range_end),
        today: cn(
          'rounded-md bg-slate-800 text-slate-100 data-[selected=true]:rounded-none',
          defaultClassNames.today,
        ),
        outside: cn(
          'text-slate-600 aria-selected:text-slate-600',
          defaultClassNames.outside,
        ),
        disabled: cn('text-slate-600 opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...rootProps }) => (
          <div
            data-slot="calendar"
            ref={rootRef}
            className={cn(className)}
            {...rootProps}
          />
        ),
        Chevron: ({ className, orientation, ...chevronProps }) => {
          if (orientation === 'left') {
            return (
              <ChevronLeftIcon className={cn('size-4', className)} {...chevronProps} />
            );
          }
          if (orientation === 'right') {
            return (
              <ChevronRightIcon className={cn('size-4', className)} {...chevronProps} />
            );
          }
          return (
            <ChevronDownIcon className={cn('size-4', className)} {...chevronProps} />
          );
        },
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const defaultClassNames = getDefaultClassNames();
  const ref = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  return (
    <Button
      ref={ref}
      variant="ghost"
      data-day={day.date.toLocaleDateString()}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        defaultClassNames.day_button,
        'flex h-[var(--cell-size)] w-[var(--cell-size)] min-h-[var(--cell-size)] min-w-[var(--cell-size)] flex-col gap-1 p-0 font-normal leading-none text-slate-200 hover:bg-slate-800 hover:text-slate-50 data-[selected-single=true]:bg-sky-500 data-[selected-single=true]:text-white data-[selected-single=true]:hover:bg-sky-400 data-[range-middle=true]:bg-slate-800 data-[range-middle=true]:text-slate-100 data-[range-start=true]:bg-sky-500 data-[range-start=true]:text-white data-[range-end=true]:bg-sky-500 data-[range-end=true]:text-white data-[range-end=true]:rounded-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-md group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-sky-500 group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-sky-500/40 [&>span]:text-xs [&>span]:opacity-70',
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
